import { PulseIndexError } from '../errors/PulseIndexError';

/**
 * Text search tokens: the tags a record carries so its text can be found by
 * typeahead, by whole word, and despite one typo.
 *
 * Tags are matched exactly, so what `indexTokens` writes must be what
 * `prefixTags`, `termTags` and `spellingTags` ask for, byte for byte. One
 * function owns each direction and the write side is built from the read side.
 * `TOKENIZER_VERSION` is written on every record, so an index built by another
 * version is refused by name (`verifyIndex`) rather than answering nothing. The
 * PHP SDK produces the same tokens, checked against the shared vectors in
 * `tests/text-token-vectors.json`.
 */
export class Text {
  /**
   * Bumped whenever normalisation, the prefix range, or the tag shape changes.
   * Records written under one version are not found by queries built by
   * another, so it is written on every record and checked by `verifyIndex`.
   */
  static readonly TOKENIZER_VERSION = 1;

  static readonly TERM_PREFIX = 't:';
  static readonly PREFIX_PREFIX = 'p:';
  static readonly TERM_PREFIX_TV = 'tv:';
  static readonly VERSION_TAG = `${Text.TERM_PREFIX_TV}${Text.TOKENIZER_VERSION}`;

  /** Shortest prefix a typeahead searches on. */
  static readonly MIN_PREFIX = 3;

  /**
   * Longest prefix written per term. A query longer than this matches the full
   * term instead.
   */
  static readonly MAX_PREFIX = 12;

  /**
   * Longest term `spellingTags` expands. Each spelling is one filter, and a
   * query may carry at most 4,096, so a longer term is matched exactly.
   */
  static readonly MAX_FUZZY_TERM = 20;

  /**
   * Letters Unicode does not decompose, folded to the Latin a person types for
   * them, so "Yıldız" matches "yildiz" and "Søren" matches "soren".
   */
  private static readonly UNDECOMPOSED: ReadonlyArray<[string, string]> = [
    ['ı', 'i'], ['ł', 'l'], ['ø', 'o'], ['đ', 'd'], ['ð', 'd'],
    ['þ', 'th'], ['æ', 'ae'], ['œ', 'oe'], ['ħ', 'h'],
  ];

  /**
   * Arabic letters people write interchangeably, folded together, so "أحمد"
   * and "احمد" are one name and "مدرسة" matches "مدرسه". Persian ی and ک fold
   * to their Arabic forms, and the tatweel is dropped.
   */
  private static readonly ARABIC: ReadonlyArray<[string, string]> = [
    ['\u0640', ''], ['ٱ', 'ا'], ['ى', 'ي'], ['ة', 'ه'], ['ی', 'ي'], ['ک', 'ك'],
  ];

  /** One-edit spellings need an alphabet; each script gets its own. */
  private static readonly ALPHABETS: ReadonlyArray<[RegExp, string]> = [
    [/\p{Script=Arabic}/u, 'ابتثجحخدذرزسشصضطظعغفقكلمنهويء'],
    [/\p{Script=Cyrillic}/u, 'абвгдежзиклмнопрстуфхцчшщъыьэюяієґ'],
    [/\p{Script=Greek}/u, 'αβγδεζηθικλμνξοπρστυφχψω'],
    [/\p{Script=Latin}|^[0-9]+$/u, 'abcdefghijklmnopqrstuvwxyz'],
  ];

  /** Lowercase, strip accents, and keep only letters, digits and spaces. */
  static normalize(input: string): string {
    return Text.fold(input, false);
  }

  /**
   * Both ways German folds to ASCII, when they differ: "Müller" is "muller"
   * and "mueller", and a person may type either. Both are written and both are
   * asked for.
   */
  static foldings(input: string): string[] {
    const plain = Text.fold(input, false);
    const german = Text.fold(input, true);
    return plain === german ? [plain] : [plain, german];
  }

  private static fold(input: string, german: boolean): string {
    // Greek final sigma to sigma first, so this SDK and the PHP one agree.
    let s = input.toLowerCase().replace(/ς/g, 'σ');
    s = german
      ? s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      : s.replace(/ß/g, 'ss');
    for (const [from, to] of Text.UNDECOMPOSED) s = s.split(from).join(to);
    s = s.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const [from, to] of Text.ARABIC) s = s.split(from).join(to);
    s = s
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
    // Letters and digits of every script stay.
    return s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /** Length and slicing in characters, never UTF-16 code units. */
  private static chars(s: string): string[] {
    return Array.from(s);
  }

  /** The words of a value, every folding, without duplicates. */
  static terms(value: string): string[] {
    const seen = new Set<string>();
    for (const folded of Text.foldings(value)) {
      for (const w of folded.split(' ')) {
        if (w) seen.add(w);
      }
    }
    return [...seen];
  }

  /** The tag an exact term match asks for. */
  static termTag(term: string): string {
    return `${Text.TERM_PREFIX}${Text.normalize(term).replace(/\s/g, '')}`;
  }

  /** The exact-match tags for a term, one per folding. Send as one group. */
  static termTags(term: string): string[] {
    const out = new Set<string>();
    for (const folded of Text.foldings(term)) {
      const t = folded.replace(/\s/g, '');
      if (t) out.add(`${Text.TERM_PREFIX}${t}`);
    }
    return [...out];
  }

  /** The first tag a typeahead asks for. Prefer `prefixTags`. */
  static prefixTag(typed: string): string {
    return Text.prefixTags(typed)[0] ?? `${Text.PREFIX_PREFIX}`;
  }

  /**
   * The tags a typeahead asks for, one per folding, to be sent as one SHOULD
   * group.
   *
   * Past MAX_PREFIX there is no stored prefix, so the full term is the right
   * question: exact, cheaper, and what the user has finished typing anyway.
   */
  static prefixTags(typed: string): string[] {
    const out = new Set<string>();
    for (const folded of Text.foldings(typed)) {
      const t = folded.replace(/\s/g, '');
      if (!t) continue;
      out.add(Text.chars(t).length > Text.MAX_PREFIX
        ? `${Text.TERM_PREFIX}${t}`
        : `${Text.PREFIX_PREFIX}${t}`);
    }
    return [...out];
  }

  /**
   * What a typeahead asks for when more than one word is typed: one group per
   * word, each group any of that word's tags, and the groups all required, so
   * "andreas mue" and "mue andreas" find the same record.
   *
   * A word before the last is matched by prefix when it has at least
   * MIN_PREFIX letters and exactly when shorter, so "dr" still narrows. The
   * last word is still being typed: under MIN_PREFIX it adds nothing yet.
   *
   * An empty result means nothing typed is long enough to search on yet.
   */
  static typeaheadGroups(typed: string): string[][] {
    const foldings = Text.foldings(typed).map((f) => f.split(' ').filter(Boolean));
    const words = Math.max(...foldings.map((f) => f.length));
    const groups: string[][] = [];
    for (let i = 0; i < words; i++) {
      const last = i === words - 1;
      const tags = new Set<string>();
      for (const folded of foldings) {
        const word = folded[i];
        if (word === undefined) continue;
        const n = Text.chars(word).length;
        if (n >= Text.MIN_PREFIX) {
          tags.add(n > Text.MAX_PREFIX ? `${Text.TERM_PREFIX}${word}` : `${Text.PREFIX_PREFIX}${word}`);
        } else if (!last) {
          tags.add(`${Text.TERM_PREFIX}${word}`);
        }
      }
      if (tags.size > 0) groups.push([...tags]);
    }
    return groups;
  }

  /**
   * Every tag one value contributes at write time, built from the same
   * functions queries use, so the two always agree.
   */
  static indexTokens(value: string): string[] {
    const out = new Set<string>([Text.VERSION_TAG]);
    for (const term of Text.terms(value)) {
      out.add(Text.termTag(term));
      const chars = Text.chars(term);
      const upper = Math.min(chars.length, Text.MAX_PREFIX);
      for (let len = Text.MIN_PREFIX; len <= upper; len++) {
        for (const tag of Text.prefixTags(chars.slice(0, len).join(''))) out.add(tag);
      }
    }
    return [...out];
  }

  /** Index tokens for several values at once, deduplicated across them. */
  static indexTokensFor(values: string[]): string[] {
    const out = new Set<string>();
    for (const v of values) for (const t of Text.indexTokens(v)) out.add(t);
    return [...out];
  }

  /**
   * Every spelling within one edit, as the tags a SHOULD group would carry.
   *
   * Deletions, transpositions, substitutions and insertions, which is what a
   * single typo actually is. The term itself is included: a correctly spelled
   * query must not lose to its own misspellings.
   */
  static spellingTags(term: string): string[] {
    const t = Text.normalize(term).replace(/\s/g, '');
    if (!t) return [];
    const c = Text.chars(t);
    if (c.length > Text.MAX_FUZZY_TERM) return [Text.termTag(t)];
    // Han, kana and Hangul get the exact term: a typo there is not a
    // one-letter edit.
    const alphabet = Text.ALPHABETS.find(([script]) => script.test(t))?.[1];
    if (alphabet === undefined) return [Text.termTag(t)];
    const letters = Text.chars(alphabet);

    const out = new Set<string>([t]);
    const join = (a: string[]) => a.join('');
    for (let i = 0; i < c.length; i++) out.add(join([...c.slice(0, i), ...c.slice(i + 1)]));
    for (let i = 0; i < c.length - 1; i++) {
      out.add(join([...c.slice(0, i), c[i + 1], c[i], ...c.slice(i + 2)]));
    }
    for (let i = 0; i < c.length; i++) {
      for (const l of letters) {
        if (l !== c[i]) out.add(join([...c.slice(0, i), l, ...c.slice(i + 1)]));
      }
    }
    for (let i = 0; i <= c.length; i++) {
      for (const l of letters) out.add(join([...c.slice(0, i), l, ...c.slice(i)]));
    }
    return [...out].map((x) => Text.termTag(x));
  }

  /** The tag that says which tokenizer built a record. */
  static versionTag(): string {
    return Text.VERSION_TAG;
  }

  /**
   * The versions `verifyIndex` looks for when its own is not present: every
   * earlier one, and a few later ones, for a tenant written by a newer SDK.
   */
  static probeVersions(): number[] {
    const out: number[] = [];
    for (let v = 1; v <= Text.TOKENIZER_VERSION + 4; v++) out.push(v);
    return out;
  }
}

/**
 * What a tokenizer-version check found.
 *
 * `indexVersion` is null when the tenant carries no text-indexed records yet,
 * which is not a mismatch.
 */
export interface TokenizerCheck {
  ok: boolean;
  /** The version the records were written under, or null if there are none. */
  indexVersion: number | null;
  /** The version this SDK generates. */
  sdkVersion: number;
}

/** What `verifyIndex` needs from a client, so a test can hand it a fake. */
export interface TextSearchExecutor {
  search(query: {
    must?: string[];
    limit?: number;
    exactTotal?: boolean;
    tenantId?: string;
  }): Promise<{ matchedEntityIds: string[] }>;
}

const verified = new WeakMap<object, Map<string, TokenizerCheck>>();

/**
 * Confirm that this SDK generates the tokens this index was built with.
 *
 * Records written by another tokenizer version are not found by this one's
 * queries, so a mismatch would read as empty results. This turns it into an
 * error that names both versions.
 *
 * Call it once, at boot, not per query. It costs one search when the versions
 * agree, and the answer is cached per client and tenant.
 *
 * ```ts
 * const check = await verifyTextIndex(client);
 * if (!check.ok) throw new Error('reindex required');
 * ```
 *
 * It throws rather than returning false when the versions genuinely disagree,
 * because a caller who ignores the return value is in exactly the silent state
 * this exists to end.
 */
export async function verifyIndex(
  client: TextSearchExecutor,
  tenantId?: string,
): Promise<TokenizerCheck> {
  const cacheKey = tenantId ?? '';
  let perTenant = verified.get(client as object);
  if (!perTenant) {
    perTenant = new Map();
    verified.set(client as object, perTenant);
  }
  const hit = perTenant.get(cacheKey);
  if (hit) return hit;

  const probe = async (v: number): Promise<boolean> => {
    const r = await client.search({
      must: [`${Text.TERM_PREFIX_TV}${v}`],
      limit: 1,
      exactTotal: false,
      ...(tenantId ? { tenantId } : {}),
    });
    return r.matchedEntityIds.length > 0;
  };

  // This SDK's version first: the usual case, one query.
  if (await probe(Text.TOKENIZER_VERSION)) {
    const ok: TokenizerCheck = {
      ok: true,
      indexVersion: Text.TOKENIZER_VERSION,
      sdkVersion: Text.TOKENIZER_VERSION,
    };
    perTenant.set(cacheKey, ok);
    return ok;
  }

  // An older index, or one written by a newer SDK.
  for (const v of Text.probeVersions()) {
    if (v === Text.TOKENIZER_VERSION) continue;
    if (await probe(v)) {
      throw new PulseIndexError(
        `this index was built by text tokenizer version ${v} and this SDK generates ` +
          `version ${Text.TOKENIZER_VERSION}; the tokens do not match, so every text ` +
          `query would return an empty page. Re-index with this SDK, or pin the SDK ` +
          `version that wrote it`,
        { code: 'PULSEINDEX_TOKENIZER_VERSION_MISMATCH' },
      );
    }
  }

  // No version present anywhere: the tenant carries no text-indexed records.
  const empty: TokenizerCheck = {
    ok: true,
    indexVersion: null,
    sdkVersion: Text.TOKENIZER_VERSION,
  };
  perTenant.set(cacheKey, empty);
  return empty;
}
