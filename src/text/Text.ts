import { PulseIndexError } from '../errors/PulseIndexError';

/**
 * Typeahead tokens, generated here and matched exactly by the engine.
 *
 * The engine hashes every attribute token to 64 bits and keeps no text, so it
 * cannot be asked what a stored token starts with. A prefix search is
 * therefore not a search at all: it is an exact match against a prefix that
 * was generated and stored at write time. The same is true of a misspelling,
 * except that the spellings are generated at query time and sent as one
 * disjunction.
 *
 * That makes this file the whole contract. Anything indexed by `indexTokens`
 * must be findable by `prefixTag` and `spellingTags`, byte for byte, forever.
 * Section 7.15 of the engine's own notes records three silent bugs in exactly
 * this shape, all of them in the geo equivalent of this file, and every one of
 * them returned a short plausible page with nothing to say it was short. So:
 *
 *   - one function owns each direction, and the write side is expressed in
 *     terms of the read side rather than duplicating it,
 *   - `TOKENIZER_VERSION` is indexed as a tag on every record, so a query
 *     built by a different version can be refused by name instead of quietly
 *     matching nothing,
 *   - the vectors in `tests/text-token-vectors.json` are shared with the PHP
 *     SDK, because two implementations of one contract need something outside
 *     both of them to agree with.
 */
export class Text {
  /**
   * Bumped whenever normalisation, the prefix range, or the tag shape changes.
   *
   * An index built by one version and queried by another produces no error and
   * no results, which is the worst failure this SDK can have. Indexing this as
   * a tag turns it into a refusal the caller can read.
   */
  static readonly TOKENIZER_VERSION = 1;

  static readonly TERM_PREFIX = 't:';
  static readonly PREFIX_PREFIX = 'p:';
  static readonly TERM_PREFIX_TV = 'tv:';
  static readonly VERSION_TAG = `${Text.TERM_PREFIX_TV}${Text.TOKENIZER_VERSION}`;

  /**
   * Shortest prefix worth storing.
   *
   * Two letters match so much of a directory that the posting list costs more
   * than the answer is worth, and no typeahead fires on two letters anyway.
   * Measured on 400,000 German doctor names: three letters answers in 1.54 us
   * and five in 1.42, so the floor costs nothing in latency and saves a large
   * posting list.
   */
  static readonly MIN_PREFIX = 3;

  /**
   * Longest prefix stored per term.
   *
   * Every extra character is another token on every record that has the term.
   * Measured on the same 400,000: prefixes took the index from 78.6 bytes per
   * record to 167.4, and that is with this ceiling in place. A query longer
   * than this falls back to the full term, which is exact and cheaper.
   */
  static readonly MAX_PREFIX = 12;

  /**
   * Longest term for which `spellingTags` will expand.
   *
   * One edit of an n-character term over a 26-letter alphabet is about 54n+25
   * spellings, and each is one SHOULD predicate. At 20 characters that is
   * roughly 1,100, and the engine refuses a query past 4,096 filters. The cap
   * keeps a long word from turning one keystroke into a refused request.
   */
  static readonly MAX_FUZZY_TERM = 20;

  /**
   * Letters Unicode does not decompose, folded to the Latin a person types for
   * them. Without this they were dropped: "Yıldız", one of the commonest
   * Turkish surnames, became three fragments, "y ld z", and "Søren" two.
   */
  private static readonly UNDECOMPOSED: ReadonlyArray<[string, string]> = [
    ['ı', 'i'], ['ł', 'l'], ['ø', 'o'], ['đ', 'd'], ['ð', 'd'],
    ['þ', 'th'], ['æ', 'ae'], ['œ', 'oe'], ['ħ', 'h'],
  ];

  /**
   * Arabic, as search engines normalise it (Lucene's ArabicNormalizer): the
   * diacritics are already gone with the other combining marks; this drops the
   * tatweel and folds the letters people write interchangeably, so "أحمد" and
   * "احمد" are one name and "مدرسة" matches "مدرسه". Persian ی and ک fold to
   * their Arabic forms.
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
   * Both ways German folds to ASCII, when they differ.
   *
   * Stripping the diaeresis turns "Müller" into "muller". Transliterating it
   * turns the same name into "mueller". Both are what a real person types,
   * and the first version of this file produced only the first: anyone typing
   * "mueller" on a keyboard without umlauts got an empty page with nothing in
   * it to say the name was there under another spelling. That is the failure
   * shape 7.15 describes, and the shared vectors caught it before it shipped.
   *
   * So both are indexed and both are asked for. Only a word actually carrying
   * one of these characters pays for the second set of tokens.
   */
  static foldings(input: string): string[] {
    const plain = Text.fold(input, false);
    const german = Text.fold(input, true);
    return plain === german ? [plain] : [plain, german];
  }

  private static fold(input: string, german: boolean): string {
    // Greek final sigma to sigma first: PHP before 8.3 lowercases Σ to σ
    // everywhere, and the two SDKs have to agree byte for byte.
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
    // Letters and digits of every script stay. This used to keep a-z and 0-9
    // only, so Arabic, Cyrillic, Greek and CJK produced no token at all and
    // every search in them came back empty, with nothing to say why.
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
   * Every tag one value contributes at write time.
   *
   * Expressed through `prefixTag` and `termTag` rather than building strings
   * again, so the two directions cannot drift apart. That drift is what 7.15
   * is about.
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
    // A script with no alphabet to substitute from, Han, kana, Hangul, gets
    // the exact term: a typo there is not a one-letter edit.
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
   * The versions `verifyIndex` looks for when its own is not present.
   *
   * Every earlier version, because an index that predates an SDK upgrade is the
   * common case, and a short way past the current one, because two services on
   * different SDK versions writing and reading one tenant is the case nobody
   * plans for and it reads as "newer", not "older". Bounded rather than open,
   * since each step is a query: four ahead is two years of bumps at this rate
   * and costs four searches once, in the failure path only.
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
 * `indexVersion` is null when the tenant carries no text-indexed records at
 * all, which is not a mismatch and is not refused: an index that has been given
 * nothing has nothing to be wrong about. That is the same call the engine makes
 * for `TenantEmpty` in `field_presence`, and for the same reason, refusing
 * there would fail a first query before a first write.
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
 * # Why this is here and not in the engine
 *
 * `Text.indexTokens` writes `tv:<n>` on every record precisely so a mismatch
 * can be named. Nothing read it until now, so it was a tag that cost a posting
 * list and bought nothing.
 *
 * It is checked here rather than in the engine on purpose. The engine names no
 * field and holds no schema (§5.10 of the engine's notes): it removed a `price`
 * and a `location_prefix` for being exactly this, one caller's vocabulary
 * living in the index. `tv:` is this SDK's invention, so this SDK is the only
 * side that can judge it without the engine learning a word.
 *
 * # What it catches
 *
 * An index built by one tokenizer and queried by another. Normalisation, the
 * prefix range and the tag shape all decide what bytes get hashed, so a change
 * to any of them means every query built by the new version misses every record
 * written by the old one. No error, no warning, an empty page: the failure
 * shape §7.15 records three times over in the geo equivalent of this file.
 *
 * # How to use it
 *
 * Once, at boot, not per query. The cost is one search when the versions agree,
 * and the answer is cached per client and tenant, so calling it again is free.
 *
 * ```ts
 * const check = await Text.verifyIndex(client);
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

  // Mine first, because agreement is the case that happens on every boot and
  // it costs exactly one query.
  if (await probe(Text.TOKENIZER_VERSION)) {
    const ok: TokenizerCheck = {
      ok: true,
      indexVersion: Text.TOKENIZER_VERSION,
      sdkVersion: Text.TOKENIZER_VERSION,
    };
    perTenant.set(cacheKey, ok);
    return ok;
  }

  // Older and newer both happen. Older is an index that predates an SDK
  // upgrade; newer is two services on different SDK versions writing and
  // reading one tenant, which is the case nobody plans for.
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
