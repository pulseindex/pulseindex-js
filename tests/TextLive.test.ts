import { describe, expect, it, beforeAll } from 'vitest';
import { PulseIndex, Text, verifyTextIndex } from '../src';

/**
 * The round trip through a real engine.
 *
 * Every unit test in Text.test.ts passed through all three of the geo bugs
 * recorded in 7.15, because each side of the contract agreed with itself. Only
 * a live engine can tell you that a token written is a token found, so this
 * file exists and is skipped rather than deleted when no engine is reachable.
 *
 *   PULSEINDEX_TEST_ENDPOINT=127.0.0.1:50055 \
 *   PULSEINDEX_TEST_API_KEY=dev-key npx vitest run tests/TextLive.test.ts
 */
const ENDPOINT = process.env.PULSEINDEX_TEST_ENDPOINT;
const API_KEY = process.env.PULSEINDEX_TEST_API_KEY ?? 'dev-key';
const TENANT = 'text-live-test';

const DOCTORS = [
  { id: 1, name: 'Dr. Andreas Müller',       spec: 'Zahnarzt',         city: 'berlin',   pop: 900 },
  { id: 2, name: 'Dr. Anna-Lena Schröder',   spec: 'Hautarzt',         city: 'hamburg',  pop: 800 },
  { id: 3, name: 'Dr. Thomas Mueller',       spec: 'Zahnarzt',         city: 'berlin',   pop: 700 },
  { id: 4, name: 'Dr. Petra Özdemir',        spec: 'Kardiologe',       city: 'muenchen', pop: 600 },
  { id: 5, name: 'Dr. Klaus Weiß',           spec: 'Gastroenterologe', city: 'berlin',   pop: 500 },
  { id: 6, name: 'Dr. Sabine Schmidt',       spec: 'Zahnarzt',         city: 'koeln',    pop: 400 },
];

describe.skipIf(!ENDPOINT)('Text, against a live engine', () => {
  let client: PulseIndex;

  beforeAll(async () => {
    client = new PulseIndex({ endpoint: ENDPOINT!, apiKey: API_KEY, tenantId: TENANT, ssl: false });
    await client.batchIndex(DOCTORS.map((d) => ({
      entityId: String(d.id),
      categories: [
        ...Text.indexTokensFor([d.name, d.spec]),
        `spec:${Text.normalize(d.spec)}`,
        `city:${d.city}`,
      ],
      numbers: { popularity: d.pop },
    })));
  }, 60_000);

  const typed = async (s: string, extra: Record<string, unknown> = {}) => {
    const r = await client.search({ should: Text.prefixTags(s), limit: 20, exactTotal: true, ...extra });
    return r.matchedEntityIds.map(Number).sort((a, b) => a - b);
  };

  it('finds an umlaut name however the umlaut was typed', async () => {
    expect(await typed('mul')).toEqual([1]);
    expect(await typed('mue')).toEqual([1, 3]);
    expect(await typed('muell')).toEqual([1, 3]);
  });

  it('narrows as more letters arrive', async () => {
    expect(await typed('sch')).toEqual([2, 6]);
    expect(await typed('schro')).toEqual([2]);
  });

  it('finds a Turkish name folded the German way', async () => {
    expect(await typed('oez')).toEqual([4]);
  });

  it('completes a specialty', async () => {
    expect(await typed('zah')).toEqual([1, 3, 6]);
  });

  it('returns nothing, and no error, for a prefix nobody carries', async () => {
    expect(await typed('xqz')).toEqual([]);
  });

  it('combines a typeahead with the filters already chosen', async () => {
    expect(await typed('mue', { must: ['spec:zahnarzt'] })).toEqual([1, 3]);
    expect(await typed('sch', { must: ['spec:zahnarzt', 'city:koeln'] })).toEqual([6]);
  });

  const typeahead = async (s: string) => {
    const r = await client.search({ typeahead: s, limit: 20, exactTotal: true });
    return r.matchedEntityIds.map(Number).sort((a, b) => a - b);
  };

  it('finds a record from more than one typed word, in any order', async () => {
    expect(await typeahead('andreas mue')).toEqual([1]);
    expect(await typeahead('mue andreas')).toEqual([1]);
    expect(await typeahead('dr thomas mü')).toEqual([3]);
    expect(await typeahead('mue zahn')).toEqual([1, 3]);
    expect(await typeahead('andreas sch')).toEqual([]);
  });

  it('recovers one typo', async () => {
    const r = await client.search({ should: Text.spellingTags('zahnarz'), limit: 20 });
    expect(r.matchedEntityIds.map(Number).sort((a, b) => a - b)).toEqual([1, 3, 6]);
  });

  it('asks for the exact term once the typed word passes the prefix ceiling', async () => {
    expect(await typed('gastroenterologe')).toEqual([5]);
  });

  it('orders by the number the caller supplies, which is the only relevance here', async () => {
    let qb = client.query().tenant(TENANT).limit(20).sortDesc('popularity');
    for (const t of Text.prefixTags('mue')) qb = qb.should(t);
    const r = await client.search(qb);
    expect(r.matchedEntityIds.map(Number)[0]).toBe(1);
  });
});

describe.skipIf(!ENDPOINT)('the tokenizer version, against a live engine', () => {
  /**
   * The unit tests above hand `verifyIndex` a fake that answers one question.
   * That proves the decision and not the tag: a version tag that was never
   * actually written, or written under a different spelling than the one the
   * check asks for, would pass every one of them. Only a real engine can say
   * that the tag on the record is the tag the probe finds, which is the whole
   * lesson of §7.15.
   */
  const client = () =>
    new PulseIndex({ endpoint: ENDPOINT!, apiKey: API_KEY, tenantId: TENANT, ssl: false });

  it('finds its own version tag on records a real engine holds', async () => {
    const check = await verifyTextIndex(client());
    expect(check.ok).toBe(true);
    expect(check.indexVersion).toBe(Text.TOKENIZER_VERSION);
  });

  it('refuses when the records really were written under another version', async () => {
    // Not a fake and not a stub: records indexed with a version tag this SDK
    // does not generate, which is byte for byte the state an SDK upgrade
    // leaves behind.
    const otherTenant = 'text-live-wrong-version';
    const wrong = new PulseIndex({
      endpoint: ENDPOINT!, apiKey: API_KEY, tenantId: otherTenant, ssl: false,
    });
    const future = Text.TOKENIZER_VERSION + 1;
    await wrong.batchIndex([
      {
        entityId: '1',
        categories: Text.indexTokens('Müller')
          .filter((t) => t !== Text.VERSION_TAG)
          .concat(`${Text.TERM_PREFIX_TV}${future}`),
      },
    ]);

    await expect(verifyTextIndex(wrong)).rejects.toMatchObject({
      code: 'PULSEINDEX_TOKENIZER_VERSION_MISMATCH',
    });
  }, 30_000);

  it('does not refuse a tenant a real engine holds nothing for', async () => {
    const virgin = new PulseIndex({
      endpoint: ENDPOINT!, apiKey: API_KEY, tenantId: `text-live-empty-${Date.now()}`, ssl: false,
    });
    const check = await verifyTextIndex(virgin);
    expect(check.ok).toBe(true);
    expect(check.indexVersion).toBeNull();
  });
});
