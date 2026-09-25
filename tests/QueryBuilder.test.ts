import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMIT,
  FilterOperation,
  GeoHash,
  PulseIndex,
  PulseIndexQueryError,
  QueryBuilder,
} from '../src';

describe('QueryBuilder', () => {
  // The default used to be 0, which the engine read as "no ceiling" and
  // answered with every matching id the tenant held. Nobody calling search()
  // without a limit meant to ask for that.
  it('carries a page size without being told', () => {
    expect(new QueryBuilder().toArray().limit).toBe(DEFAULT_LIMIT);
  });

  // Zero is still expressible, and now means the total with no ids attached.
  it('keeps zero for callers who only want the count', () => {
    expect(new QueryBuilder().limit(0).toArray().limit).toBe(0);
  });

  it('compiles an immutable fluent payload', () => {
    const base = new QueryBuilder();
    const built = base
      .tenant('acme')
      .must('feature:pool')
      .should('amenity:parking')
      .mustNot('feature:shared')
      .range('price', 100, 500)
      .exactTotal()
      .limit(25)
      .offset(10);

    expect(base.toArray().filters).toEqual([]);
    expect(built.toArray()).toEqual({
      tenantId: 'acme',
      limit: 25,
      offset: 10,
      exactTotal: true,
      filters: [
        { op: FilterOperation.MUST, attribute: 'feature:pool', group: 0 },
        { op: FilterOperation.SHOULD, attribute: 'amenity:parking', group: 0 },
        { op: FilterOperation.MUST_NOT, attribute: 'feature:shared', group: 0 },
      ],
      ranges: [{ field: 'price', minVal: 100, maxVal: 500 }],
    });
  });

  it('accepts array SHOULD / MUST filters', () => {
    const request = PulseIndex.query()
      .tenant('acme_corp')
      .must('features:swimming_pool')
      .should(['category:villa', 'category:apartment'])
      .mustNot('status:sold')
      .range('price', 100000, 500000)
      .limit(50)
      .toRequest();

    expect(request.tenantId).toBe('acme_corp');
    expect(request.limit).toBe(50);
    // Both SHOULD terms land in group 0, which is one disjunction: villa or
    // apartment.
    expect(request.filters).toEqual([
      { op: FilterOperation.MUST, attribute: 'features:swimming_pool', group: 0 },
      { op: FilterOperation.SHOULD, attribute: 'category:villa', group: 0 },
      { op: FilterOperation.SHOULD, attribute: 'category:apartment', group: 0 },
      { op: FilterOperation.MUST_NOT, attribute: 'status:sold', group: 0 },
    ]);
    expect(request.ranges).toEqual([{ field: 'price', minVal: 100000, maxVal: 500000 }]);
  });

  it('adds a MUST geo tag for whereGeoHash / inGeoHash', () => {
    const viaWhere = new QueryBuilder().whereGeoHash('ezs42').toRequest();
    const viaIn = new QueryBuilder().inGeoHash('geo:5:ezs42').toArray();

    expect(viaWhere.filters).toEqual([
      { op: FilterOperation.MUST, attribute: 'geo:5:ezs42', group: 0 },
    ]);
    expect(viaIn.filters).toEqual(viaWhere.filters);
  });

  it('adds SHOULD geo tags for covering hashes on withinRadius', () => {
    const lat = 42.6;
    const lon = -5.6;
    const radiusKm = 4.9;
    const covering = GeoHash.getCoveringHashes(lat, lon, radiusKm);
    const base = new QueryBuilder();
    const built = base.withinRadius(lat, lon, radiusKm);
    const request = built.toRequest();

    expect(base.toArray().filters).toEqual([]);
    expect(request.filters).toHaveLength(covering.length);
    // 5: the coarse cell wastes 1.89x the circle here, inside what a
    // pre-filter may waste, and it costs 10 cells against the fine cell's 199.
    expect(GeoHash.optimalPrecisionForRadius(radiusKm, lat, lon)).toBe(5);
    expect(request.filters.map((filter) => filter.attribute)).toEqual(covering.map((hash) => GeoHash.tag(hash)));
    // Group 1, not 0: the covering cells are one geographic constraint spelled
    // as "any of these", and they must not merge with a disjunction the caller
    // wrote themselves.
    expect(request.filters[0]).toEqual({
      op: FilterOperation.SHOULD,
      attribute: 'geo:5:ezs42',
      group: 1,
    });
    for (const filter of request.filters) {
      expect(filter.op).toBe(FilterOperation.SHOULD);
      expect(filter.group).toBe(1);
      expect(filter.attribute).toMatch(/^geo:5:[0-9bcdefghjkmnpqrstuvwxyz]+$/);
    }
  });

  it('keeps a radius out of the caller\'s own disjunction', () => {
    const request = PulseIndex.query()
      .should(['color:red', 'color:blue'])
      .withinRadius(42.6, -5.6, 4.9)
      .toRequest();

    const colours = request.filters.filter((f) => f.attribute.startsWith('color:'));
    const cells = request.filters.filter((f) => f.attribute.startsWith('geo:'));

    expect(colours.every((f) => f.group === 0)).toBe(true);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((f) => f.group === 1)).toBe(true);
  });

  it('gives each radius its own disjunction', () => {
    const request = PulseIndex.query()
      .withinRadius(42.6, -5.6, 4.9)
      .withinRadius(48.85, 2.35, 4.9)
      .toRequest();

    const groups = new Set(request.filters.map((f) => f.group));
    expect(groups.size).toBe(2);
    expect([...groups].sort()).toEqual([1, 2]);
  });

  it('does not hand a radius a group the caller already named', () => {
    const request = PulseIndex.query()
      .should(['a:1', 'a:2'], 3)
      .withinRadius(42.6, -5.6, 4.9)
      .toRequest();

    const named = request.filters.filter((f) => f.attribute.startsWith('a:'));
    const cells = request.filters.filter((f) => f.attribute.startsWith('geo:'));
    expect(named.every((f) => f.group === 3)).toBe(true);
    expect(cells.every((f) => f.group === 4)).toBe(true);
  });

  it('orders a page by a numeric field', () => {
    expect(PulseIndex.query().sortAsc('price').toRequest().sort).toEqual({
      field: 'price',
      descending: false,
    });
    expect(PulseIndex.query().sortDesc('price').toRequest().sort).toEqual({
      field: 'price',
      descending: true,
    });
    // Absent unless asked for: an unordered query is still entity-id order.
    expect(PulseIndex.query().must('k:a').toRequest().sort).toBeUndefined();
    expect(() => PulseIndex.query().sortAsc('  ')).toThrow();
  });

  it('reads groups and ordering from the plain options form', () => {
    const request = PulseIndex.query()
      .tenant('acme')
      .toRequest();
    expect(request.sort).toBeUndefined();

    const fromOptions = QueryBuilder.fromOptions({
      tenantId: 'acme',
      should: ['color:red', 'color:blue'],
      sortBy: { field: 'price', descending: true },
    }).toRequest();

    expect(fromOptions.sort).toEqual({ field: 'price', descending: true });
    expect(fromOptions.filters.every((f) => f.group === 0)).toBe(true);
  });

  it('accepts object-form withinRadius with lng', () => {
    const lat = 41.0082;
    const lng = 28.9784;
    const covering = GeoHash.getCoveringHashes(lat, lng, 5);
    const request = PulseIndex.query()
      .withinRadius({ lat, lng, radiusKm: 5 })
      .toRequest();

    expect(request.filters.map((filter) => filter.attribute)).toEqual(covering.map((hash) => GeoHash.tag(hash)));
    expect(request.filters.every((filter) => filter.op === FilterOperation.SHOULD)).toBe(true);
  });

  it('honors explicit withinRadius precision', () => {
    const covering = GeoHash.getCoveringHashes(42.6, -5.6, 1.0, 6);
    const request = new QueryBuilder().withinRadius(42.6, -5.6, 1.0, 6).toRequest();

    expect(request.filters).toHaveLength(covering.length);
    expect(request.filters[0]?.attribute).toBe(`geo:6:${covering[0]}`);
    expect(request.filters[0]?.op).toBe(FilterOperation.SHOULD);
  });

  it('builds from SearchRequestOptions', () => {
    const request = QueryBuilder.fromOptions({
      tenantId: 'acme',
      must: 'feature:pool',
      should: ['category:villa', 'category:apartment'],
      mustNot: 'status:sold',
      ranges: [{ field: 'price', min: 10, max: 20 }],
      limit: 5,
      offset: 2,
    }).toRequest();

    expect(request.tenantId).toBe('acme');
    expect(request.limit).toBe(5);
    expect(request.offset).toBe(2);
    expect(request.filters).toHaveLength(4);
    expect(request.ranges[0]).toEqual({ field: 'price', minVal: 10, maxVal: 20 });
  });

  it('rejects inverted ranges and execute without a client', () => {
    expect(() => new QueryBuilder().range('price', 500, 100)).toThrow(PulseIndexQueryError);
    expect(() => new QueryBuilder().execute()).toThrow(/no client/);
  });

  it('carries a circle and an order by distance onto the request', () => {
    const request = PulseIndex.query()
      .must('kind:driver')
      .within('where', 41.0369, 28.985, 3)
      .nearest('where', 41.0369, 28.985)
      .limit(50)
      .toRequest('acme');

    expect(request.geo).toEqual({ field: 'where', lat: 41.0369, lon: 28.985, radiusKm: 3 });
    expect(request.sort).toEqual({ field: 'where', descending: false, byDistance: true });
  });

  it('keeps the radius when nearest is asked for after within', () => {
    const request = PulseIndex.query()
      .within('where', 41, 29, 7.5)
      .nearest('where', 41, 29)
      .toRequest();
    expect(request.geo?.radiusKm).toBe(7.5);
  });

  it('adds the cells and the exact circle together when withinRadius names a field', () => {
    const request = PulseIndex.query()
      .withinRadius({ lat: 41.0369, lng: 28.985, radiusKm: 2, field: 'where' })
      .toRequest();

    expect(request.geo).toEqual({ field: 'where', lat: 41.0369, lon: 28.985, radiusKm: 2 });
    expect(request.filters.length).toBeGreaterThan(0);
    // The cells narrow; the circle settles the edge. Without the field the
    // cells are the whole answer and are a superset of the circle.
    const withoutField = PulseIndex.query()
      .withinRadius({ lat: 41.0369, lng: 28.985, radiusKm: 2 })
      .toRequest();
    expect(withoutField.geo).toBeUndefined();
    expect(withoutField.filters.length).toBe(request.filters.length);
  });

  // Both bounds used to be floored. Flooring a minimum widens the range and
  // flooring a maximum narrows it, so the same silent rounding was wrong in
  // opposite directions, and the answer came back looking complete either way.
  it('refuses a fractional bound rather than moving it', () => {
    expect(() => PulseIndex.query().range('rating', 4.3, 5)).toThrow(PulseIndexQueryError);
    expect(() => PulseIndex.query().range('rating', 4, 4.9)).toThrow(PulseIndexQueryError);
    expect(PulseIndex.query().range('price', 1000, 5000).toArray().ranges).toEqual([
      { field: 'price', minVal: 1000, maxVal: 5000 },
    ]);
  });

  // A negative bound was unreachable while the column was a uint32.
  it('carries a negative bound, because the column is signed', () => {
    expect(PulseIndex.query().range('delta', -500, -1).toArray().ranges).toEqual([
      { field: 'delta', minVal: -500, maxVal: -1 },
    ]);
  });

  it('refuses a circle it cannot measure', () => {
    expect(() => PulseIndex.query().within('', 41, 29, 1)).toThrow();
    expect(() => PulseIndex.query().within('where', Number.NaN, 29, 1)).toThrow();
    expect(() => PulseIndex.query().within('where', 41, 29, -1)).toThrow();
    expect(() => PulseIndex.query().nearest('', 41, 29)).toThrow();
  });

});

describe('a search option the SDK does not know', () => {
  /**
   * Reproduced against production on 2026-09-25: `range` instead of `ranges`
   * ran the search with no range at all and returned a plausible page, with
   * nothing to say the filter had been dropped. The PHP SDK already refuses an
   * unknown key on a record; this is the same rule for a search.
   */
  it('is refused by name rather than ignored', () => {
    expect(() =>
      QueryBuilder.fromOptions({ must: ['a:b'], range: [{ field: 'price', min: 1, max: 2 }] } as never),
    ).toThrow(/unknown search option "range".*ranges/);
  });

  it('names the likely meaning of the common slips', () => {
    const cases: Array<[string, RegExp]> = [
      ['filters', /must/],
      ['filter', /must/],
      ['where', /must/],
      ['sort', /sortBy/],
      ['orderBy', /sortBy/],
      ['radius', /withinRadius/],
      ['tenant', /tenantId/],
    ];
    for (const [key, hint] of cases) {
      expect(() => QueryBuilder.fromOptions({ [key]: 'x' } as never)).toThrow(hint);
    }
  });

  it('still accepts every option it documents', () => {
    expect(() =>
      QueryBuilder.fromOptions({
        tenantId: 't',
        exactTotal: true,
        must: ['a:b'],
        should: ['c:d'],
        mustNot: ['e:f'],
        ranges: [{ field: 'price', min: 1, max: 2 }],
        limit: 10,
        offset: 0,
        sortBy: { field: 'price' },
      }),
    ).not.toThrow();
  });
});
