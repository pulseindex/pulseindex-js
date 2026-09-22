import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Text, verifyIndex as verifyTextIndex } from '../src/text/Text';

/**
 * The contract these tests hold is one sentence: anything `indexTokens` writes
 * must be reachable by what `prefixTags`, `termTags` and `spellingTags` ask
 * for. Section 7.15 of the engine notes records three silent bugs of exactly
 * this shape in the geo module, every one of them a plausible short page, so
 * the round trip is asserted directly rather than inferred from the parts.
 */
describe('Text', () => {
  describe('normalisation', () => {
    it('folds a German name both ways a person would type it', () => {
      expect(Text.terms('Müller')).toEqual(['muller', 'mueller']);
      expect(Text.terms('Schröder')).toEqual(['schroder', 'schroeder']);
      expect(Text.terms('Weiß')).toEqual(['weiss']);
    });

    it('leaves a word with no special characters alone', () => {
      expect(Text.foldings('Zahnarzt')).toEqual(['zahnarzt']);
    });

    it('handles the Turkish dotted capital', () => {
      expect(Text.terms('İstanbul')).toContain('istanbul');
    });

    it('splits on punctuation rather than swallowing it', () => {
      expect(Text.terms('Dr. Anna-Lena')).toEqual(['dr', 'anna', 'lena']);
    });

    it('is idempotent, so double normalising cannot drift', () => {
      for (const s of ['Müller', 'İstanbul', 'O’Brien', '  a  b ']) {
        expect(Text.normalize(Text.normalize(s))).toBe(Text.normalize(s));
      }
    });
  });

  describe('the round trip, which is the whole point', () => {
    const NAMES = ['Müller', 'Schröder', 'Zahnarzt', 'Gastroenterologe', 'Özdemir', 'abc'];

    it('finds every indexed value by every prefix a user could have typed', () => {
      for (const name of NAMES) {
        const indexed = new Set(Text.indexTokens(name));
        for (const term of Text.terms(name)) {
          const upper = Math.min(term.length, Text.MAX_PREFIX);
          for (let len = Text.MIN_PREFIX; len <= upper; len++) {
            const asked = Text.prefixTags(term.slice(0, len));
            expect(asked.some((t) => indexed.has(t)),
              `${name}: nothing indexed answers "${term.slice(0, len)}"`).toBe(true);
          }
        }
      }
    });

    it('finds a German name when the umlaut is typed out', () => {
      const indexed = new Set(Text.indexTokens('Müller'));
      for (const typed of ['mue', 'muel', 'mueller', 'mul', 'mull', 'muller']) {
        expect(Text.prefixTags(typed).some((t) => indexed.has(t)),
          `typing "${typed}" found nothing`).toBe(true);
      }
    });

    it('finds an exact term by termTags', () => {
      const indexed = new Set(Text.indexTokens('Schröder'));
      for (const typed of ['Schröder', 'schroder', 'schroeder']) {
        expect(Text.termTags(typed).some((t) => indexed.has(t))).toBe(true);
      }
    });

    it('recovers a single typo', () => {
      const indexed = new Set(Text.indexTokens('Zahnarzt'));
      for (const typo of ['zahnarz', 'zahnrazt', 'zahnarzr', 'zahnaarzt']) {
        expect(Text.spellingTags(typo).some((t) => indexed.has(t)),
          `"${typo}" did not recover`).toBe(true);
      }
    });

    it('does not claim to recover two typos', () => {
      const indexed = new Set(Text.indexTokens('Zahnarzt'));
      expect(Text.spellingTags('zhanarzr').some((t) => indexed.has(t))).toBe(false);
    });
  });

  describe('bounds', () => {
    it('stores no prefix shorter than the floor', () => {
      for (const tag of Text.indexTokens('abcdef')) {
        if (tag.startsWith(Text.PREFIX_PREFIX)) {
          expect(tag.length - Text.PREFIX_PREFIX.length).toBeGreaterThanOrEqual(Text.MIN_PREFIX);
        }
      }
    });

    it('stores no prefix longer than the ceiling', () => {
      for (const tag of Text.indexTokens('gastroenterologe')) {
        if (tag.startsWith(Text.PREFIX_PREFIX)) {
          expect(tag.length - Text.PREFIX_PREFIX.length).toBeLessThanOrEqual(Text.MAX_PREFIX);
        }
      }
    });

    it('asks for the exact term once the typed word passes the ceiling', () => {
      const asked = Text.prefixTags('gastroenterologe');
      expect(asked.every((t) => t.startsWith(Text.TERM_PREFIX))).toBe(true);
    });

    it('a word shorter than the floor gets a term tag and no prefixes', () => {
      const tokens = Text.indexTokens('ab');
      expect(tokens).toContain('t:ab');
      expect(tokens.filter((t) => t.startsWith(Text.PREFIX_PREFIX))).toHaveLength(0);
    });

    it('refuses to expand a term long enough to blow the filter ceiling', () => {
      const long = 'a'.repeat(Text.MAX_FUZZY_TERM + 1);
      expect(Text.spellingTags(long)).toEqual([Text.termTag(long)]);
    });

    it('keeps one edit of a realistic name inside the engine filter ceiling', () => {
      expect(Text.spellingTags('gastroenterolog').length).toBeLessThan(4096);
    });
  });

  describe('the version tag', () => {
    it('is on every indexed value, so a stale query can be refused by name', () => {
      expect(Text.indexTokens('anything')).toContain(Text.versionTag());
    });
  });

  describe('the vectors the PHP SDK will assert against', () => {
    it('matches the shared fixture', () => {
      const vectors = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'text-token-vectors.json'), 'utf8'),
      ) as Array<{ input: string; normalized: string; terms: string[]; indexTokens: string[] }>;

      expect(vectors.length).toBeGreaterThan(0);
      for (const v of vectors) {
        expect(Text.normalize(v.input), v.input).toBe(v.normalized);
        expect(Text.terms(v.input), v.input).toEqual(v.terms);
        expect([...Text.indexTokens(v.input)].sort(), v.input).toEqual(v.indexTokens);
      }
    });
  });
});

describe('the tokenizer version, which was written and never read', () => {
  /**
   * A fake engine that knows only which tag was asked for.
   *
   * `verifyIndex` asks exactly one question, "does any record carry tv:n", so a
   * fake that answers it is the whole surface. Building the check against a
   * real engine would test the engine; this tests the decision.
   */
  const engineHolding = (versions: number[]) => {
    const calls: string[] = [];
    return {
      calls,
      search: async (q: { must?: string[] }) => {
        const tag = q.must?.[0] ?? '';
        calls.push(tag);
        const n = Number(tag.replace('tv:', ''));
        return { matchedEntityIds: versions.includes(n) ? ['1'] : [] };
      },
    };
  };

  it('passes when the index was written by this same tokenizer', async () => {
    const engine = engineHolding([Text.TOKENIZER_VERSION]);
    const check = await verifyTextIndex(engine);
    expect(check).toEqual({
      ok: true,
      indexVersion: Text.TOKENIZER_VERSION,
      sdkVersion: Text.TOKENIZER_VERSION,
    });
    // Agreement is what happens on every boot, so it must cost one query.
    expect(engine.calls).toEqual([`tv:${Text.TOKENIZER_VERSION}`]);
  });

  /**
   * Only the newer direction is testable while TOKENIZER_VERSION is 1, because
   * nothing older than 1 exists to hold. The mechanism is one loop over
   * `probeVersions()` and does not care which side of the current version it
   * finds, so this covers both. A test asserting the older direction today
   * would pass without running anything, which is worse than not having it.
   */
  it('refuses an index written by a newer tokenizer', async () => {
    const newer = engineHolding([Text.TOKENIZER_VERSION + 2]);
    await expect(verifyTextIndex(newer)).rejects.toThrow(
      new RegExp(`version ${Text.TOKENIZER_VERSION + 2}`),
    );
  });

  it('names the mismatch with a code a caller can branch on', async () => {
    const newer = engineHolding([Text.TOKENIZER_VERSION + 1]);
    await expect(verifyTextIndex(newer)).rejects.toMatchObject({
      code: 'PULSEINDEX_TOKENIZER_VERSION_MISMATCH',
    });
  });

  /**
   * The opposite mistake, and the one that would make this check unusable. An
   * engine that has been given nothing has nothing to be wrong about, and
   * refusing here would fail a first query before a first write. Same call the
   * engine makes for TenantEmpty.
   */
  it('does not refuse a tenant that carries no text records at all', async () => {
    const empty = engineHolding([]);
    const check = await verifyTextIndex(empty);
    expect(check.ok).toBe(true);
    expect(check.indexVersion).toBeNull();
  });

  it('asks once per client and tenant, because boot code calls it in a loop', async () => {
    const engine = engineHolding([Text.TOKENIZER_VERSION]);
    await verifyTextIndex(engine);
    await verifyTextIndex(engine);
    await verifyTextIndex(engine);
    expect(engine.calls).toHaveLength(1);

    // A different tenant on the same client is a different index.
    await verifyTextIndex(engine, 'another-tenant');
    expect(engine.calls).toHaveLength(2);
  });

  it('writes the version tag on every record, or there is nothing to check', async () => {
    expect(Text.indexTokens('Müller')).toContain(Text.VERSION_TAG);
    expect(Text.indexTokensFor(['a', 'b'])).toContain(Text.VERSION_TAG);
  });
});
