import { GeoHash } from '../geo/GeoHash';
import { PulseIndexQueryError } from '../errors/PulseIndexError';
import {
  FilterOperation,
  type FilterOperationCode,
  type FilterPredicate,
  type RadiusOptions,
  type GeoPredicate,
  type RangePredicate,
  type SearchQueryRequest,
  type SearchRequestOptions,
  type SearchResponse,
  type SortSpec,
} from '../types';

export interface QueryExecutor {
  search(query: QueryBuilder): Promise<SearchResponse>;
}

interface QueryState {
  tenantId: string;
  exactTotal: boolean;
  geo: GeoPredicate | null;
  limit: number;
  offset: number;
  filters: FilterPredicate[];
  ranges: RangePredicate[];
  sort: SortSpec | null;
  /**
   * The next disjunction number to hand out.
   *
   * Group 0 is the default and belongs to plain `should()` calls. Anything
   * that builds a disjunction of its own, a radius, which becomes one SHOULD
   * per covering geohash, takes a number from here so it cannot merge with a
   * disjunction the caller wrote.
   */
  nextGroup: number;
}

/**
 * A page, for callers who never say otherwise.
 *
 * The default used to be 0, which the engine read as "no ceiling" and answered
 * with every matching id the tenant held. Nobody meant to ask for that, and
 * the cost of it landed on the service rather than on the caller who forgot
 * the limit. Zero is still expressible and now means the total alone.
 */
export const DEFAULT_LIMIT = 100;

function emptyState(): QueryState {
  return {
    tenantId: '',
    exactTotal: false,
    geo: null,
    limit: DEFAULT_LIMIT,
    offset: 0,
    filters: [],
    ranges: [],
    sort: null,
    nextGroup: 1,
  };
}

function asAttributeList(value: string | string[]): string[] {
  const items = Array.isArray(value) ? value : [value];
  const normalized = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (normalized.length === 0) {
    throw new PulseIndexQueryError('Attribute filter must not be empty.');
  }
  return normalized;
}

function resolveLongitude(options: RadiusOptions): number {
  const value = options.lng ?? options.lon;
  if (value === undefined) {
    throw new PulseIndexQueryError('withinRadius requires lng or lon.');
  }
  return value;
}

export class QueryBuilder {
  private readonly executor: QueryExecutor | null;
  private state: QueryState;

  constructor(executor: QueryExecutor | null = null) {
    this.executor = executor;
    this.state = emptyState();
  }

  tenant(tenantId: string): QueryBuilder {
    return this.fork((state) => {
      state.tenantId = tenantId;
    });
  }

  /**
   * Count every match instead of stopping as soon as the page is full.
   *
   * A paged search stops early, so the `totalMatches` it carries is only what
   * the engine had counted by then, a lower bound, and one that does not look
   * like one. This makes the count exact in the same request; `totalIsExact`
   * on the response says which you got.
   */
  exactTotal(enabled = true): QueryBuilder {
    return this.fork((state) => {
      state.exactTotal = enabled;
    });
  }

  must(attribute: string | string[]): QueryBuilder {
    return this.addFilters(FilterOperation.MUST, attribute);
  }

  /**
   * At least one of these has to match.
   *
   * Pass a `group` to keep a disjunction separate from another one. Members of
   * a group are OR'd together and the groups are AND'd with each other, so
   * `.should(['color:red', 'color:blue'], 1).should(['size:s', 'size:m'], 2)`
   * asks for a red or blue shirt in small or medium. Without the group numbers
   * all four collapse into a single OR, which answers a different question and
   * says nothing about it.
   */
  should(attribute: string | string[], group = 0): QueryBuilder {
    return this.addFilters(FilterOperation.SHOULD, attribute, group);
  }

  mustNot(attribute: string | string[]): QueryBuilder {
    return this.addFilters(FilterOperation.MUST_NOT, attribute);
  }

  whereGeoHash(geohash: string): QueryBuilder {
    return this.must(GeoHash.tag(geohash));
  }

  inGeoHash(geohash: string): QueryBuilder {
    return this.whereGeoHash(geohash);
  }

  withinRadius(lat: number, lon: number, radiusKm: number, precision?: number): QueryBuilder;
  withinRadius(options: RadiusOptions): QueryBuilder;
  withinRadius(
    latOrOptions: number | RadiusOptions,
    lon?: number,
    radiusKm?: number,
    precision?: number,
  ): QueryBuilder {
    let lat: number;
    let longitude: number;
    let radius: number;
    let resolvedPrecision: number | undefined;

    if (typeof latOrOptions === 'object') {
      lat = latOrOptions.lat;
      longitude = resolveLongitude(latOrOptions);
      radius = latOrOptions.radiusKm;
      resolvedPrecision = latOrOptions.precision;
    } else {
      if (lon === undefined || radiusKm === undefined) {
        throw new PulseIndexQueryError('withinRadius(lat, lon, radiusKm) requires all three arguments.');
      }
      lat = latOrOptions;
      longitude = lon;
      radius = radiusKm;
      resolvedPrecision = precision;
    }

    const covering = GeoHash.getCoveringHashes(lat, longitude, radius, resolvedPrecision);
    const field = typeof latOrOptions === 'object' ? latOrOptions.field : undefined;
    return this.fork((state) => {
      // Given a position field, the cells become what they are good at -
      // narrowing which parts of the index are opened - and the engine settles
      // the edge by measuring. Without one the cells are the whole answer, and
      // a union of cells is a superset of the circle.
      if (field) {
        state.geo = { field, lat, lon: longitude, radiusKm: radius };
      }
      // A disjunction of its own. These are one geographic constraint spelled
      // as "any of these cells", and before groups existed they went into the
      // same OR as everything else the caller had asked for with `should()`,
      // so "within 5 km and (red or blue)" was answered as "within 5 km or red
      // or blue", quietly, with a plausible-looking page of results.
      const group = state.nextGroup;
      state.nextGroup += 1;
      for (const hash of covering) {
        state.filters.push({
          op: FilterOperation.SHOULD,
          attribute: GeoHash.tag(hash),
          group,
        });
      }
    });
  }

  /**
   * Filter on a numeric field's inclusive range.
   *
   * The field is one you named yourself in the entity's `numbers`. The engine
   * names none of them, it carried a single `uint32` called `price` until
   * 5.0, which was a schema it had no business holding.
   *
   * A range on a field no entity in your tenant carries is refused by name
   * rather than answered, because a field nothing carries can only match
   * nothing, and an empty page looks exactly like a real one.
   *
   * A fractional bound is refused rather than rounded, the same way a
   * fractional value is at index time. Both bounds used to be floored, which
   * is wrong in opposite directions: flooring a minimum widens the range and
   * flooring a maximum narrows it, and neither said so.
   */
  range(field: string, min: number, max: number): QueryBuilder {
    if (!field.trim()) {
      throw new PulseIndexQueryError('Range field must not be empty.');
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new PulseIndexQueryError('Range bounds must be finite numbers.');
    }
    for (const [name, value] of [
      ['min', min],
      ['max', max],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new PulseIndexQueryError(
          `Range ${name} for "${field}" is ${value}, and the engine's column is a 64-bit ` +
            'integer. Scale it yourself, a price in cents, a rating out of 100, rather ' +
            'than having a bound moved for you.',
        );
      }
    }
    if (min > max) {
      throw new PulseIndexQueryError(`Range min (${min}) must be <= max (${max}).`);
    }

    return this.fork((state) => {
      state.ranges.push({ field, minVal: min, maxVal: max });
    });
  }

  /**
   * How many ids to return. Zero asks the engine for the number of matches
   * and no ids at all, which is the cheap way to count.
   */
  limit(limit: number): QueryBuilder {
    return this.fork((state) => {
      state.limit = Math.max(0, Math.floor(limit));
    });
  }

  offset(offset: number): QueryBuilder {
    return this.fork((state) => {
      state.offset = Math.max(0, Math.floor(offset));
    });
  }

  /**
   * Order the page by a numeric field, smallest first.
   *
   * An ordered search cannot stop as soon as the page is full, the cheapest
   * remaining row may be anywhere in the tenant, so it costs more than the
   * same filter unordered. `offset + limit` is capped at 100,000.
   */
  sortAsc(field: string): QueryBuilder {
    return this.sortBy(field, false);
  }

  /** Order the page by a numeric field, largest first. */
  sortDesc(field: string): QueryBuilder {
    return this.sortBy(field, true);
  }

  /**
   * Order the page by a numeric field.
   *
   * Bounded exactly as {@link range} is: `price` is the only field an entity
   * carries, and any other name is refused rather than silently ignored. An
   * order by a field nothing carries used to leave the page in insertion order
   * and report it as sorted.
   */
  sortBy(field: string, descending = false): QueryBuilder {
    if (!field.trim()) {
      throw new PulseIndexQueryError('Sort field must not be empty.');
    }
    return this.fork((state) => {
      state.sort = { field, descending };
    });
  }

  /**
   * Keep only entities within `radiusKm` of the point, measured exactly.
   *
   * This is the circle on its own. {@link withinRadius} with a `field` adds
   * the geohash cells too, which is what stops the engine opening every part
   * of the index to find them.
   */
  within(field: string, lat: number, lon: number, radiusKm: number): QueryBuilder {
    if (!field.trim()) {
      throw new PulseIndexQueryError('A position field name must not be empty.');
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) {
      throw new PulseIndexQueryError('within(field, lat, lon, radiusKm) needs finite numbers.');
    }
    if (radiusKm < 0) {
      throw new PulseIndexQueryError(`A circle cannot have a radius of ${radiusKm}.`);
    }
    return this.fork((state) => {
      state.geo = { field, lat, lon, radiusKm };
    });
  }

  /**
   * Order the page by distance from the point, nearest first.
   *
   * Without a radius this is "the nearest K of whatever else matched"; combine
   * it with {@link within} or {@link withinRadius} to bound the search as well.
   * It used to be impossible: a radius returned everything inside it unordered,
   * so you hydrated every id from your own store before you could sort them.
   */
  nearest(field: string, lat: number, lon: number): QueryBuilder {
    if (!field.trim()) {
      throw new PulseIndexQueryError('A position field name must not be empty.');
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new PulseIndexQueryError('nearest(field, lat, lon) needs finite numbers.');
    }
    return this.fork((state) => {
      state.geo = { field, lat, lon, radiusKm: state.geo?.radiusKm ?? 0 };
      state.sort = { field, descending: false, byDistance: true };
    });
  }

  toRequest(defaultTenantId = ''): SearchQueryRequest {
    const request: SearchQueryRequest = {
      tenantId: this.state.tenantId || defaultTenantId,
      limit: this.state.limit,
      offset: this.state.offset,
      exactTotal: this.state.exactTotal,
      filters: this.state.filters.map((filter) => ({ ...filter })),
      ranges: this.state.ranges.map((range) => ({ ...range })),
    };
    if (this.state.sort) {
      request.sort = { ...this.state.sort };
    }
    if (this.state.geo) {
      request.geo = { ...this.state.geo };
    }
    return request;
  }

  toArray(defaultTenantId = ''): SearchQueryRequest {
    return this.toRequest(defaultTenantId);
  }

  execute(): Promise<SearchResponse> {
    if (!this.executor) {
      throw new PulseIndexQueryError(
        'QueryBuilder has no client; pass the builder to client.search() or create it via client.query().',
      );
    }
    return this.executor.search(this);
  }

  static fromOptions(
    options: SearchRequestOptions,
    executor: QueryExecutor | null = null,
  ): QueryBuilder {
    assertKnownSearchOptions(options);
    let query = new QueryBuilder(executor);

    if (options.tenantId !== undefined) {
      query = query.tenant(options.tenantId);
    }
    if (options.exactTotal !== undefined) {
      query = query.exactTotal(options.exactTotal);
    }
    if (options.must !== undefined) {
      query = query.must(options.must);
    }
    if (options.should !== undefined) {
      query = query.should(options.should);
    }
    if (options.mustNot !== undefined) {
      query = query.mustNot(options.mustNot);
    }
    if (options.ranges) {
      for (const range of options.ranges) {
        query = query.range(range.field, range.min, range.max);
      }
    }
    if (options.withinRadius) {
      query = query.withinRadius(options.withinRadius);
    }
    if (options.geoHash) {
      query = query.whereGeoHash(options.geoHash);
    }
    if (options.limit !== undefined) {
      query = query.limit(options.limit);
    }
    if (options.offset !== undefined) {
      query = query.offset(options.offset);
    }
    if (options.sortBy !== undefined) {
      query = query.sortBy(options.sortBy.field, options.sortBy.descending ?? false);
    }

    return query;
  }

  private addFilters(
    op: FilterOperationCode,
    attribute: string | string[],
    group = 0,
  ): QueryBuilder {
    const attributes = asAttributeList(attribute);
    const normalizedGroup = Math.max(0, Math.floor(group));
    return this.fork((state) => {
      for (const value of attributes) {
        state.filters.push({ op, attribute: value, group: normalizedGroup });
      }
      // A caller naming their own group must not have it handed out again to a
      // radius later in the same chain.
      if (normalizedGroup >= state.nextGroup) {
        state.nextGroup = normalizedGroup + 1;
      }
    });
  }

  private fork(mutate: (state: QueryState) => void): QueryBuilder {
    const next = new QueryBuilder(this.executor);
    next.state = {
      tenantId: this.state.tenantId,
      limit: this.state.limit,
      offset: this.state.offset,
      exactTotal: this.state.exactTotal,
      filters: this.state.filters.map((filter) => ({ ...filter })),
      ranges: this.state.ranges.map((range) => ({ ...range })),
      sort: this.state.sort ? { ...this.state.sort } : null,
      geo: this.state.geo ? { ...this.state.geo } : null,
      nextGroup: this.state.nextGroup,
    };
    mutate(next.state);
    return next;
  }
}

/**
 * Every search option this SDK reads. Anything else is refused by name.
 *
 * An unknown key used to be ignored, so a typo ran a different search than the
 * one written: `range` for `ranges`, reproduced against production on
 * 2026-09-25, dropped the price range and still returned a plausible page. The
 * PHP SDK already refuses an unknown key on a record for the same reason.
 */
const KNOWN_SEARCH_OPTIONS = new Set([
  'tenantId', 'exactTotal', 'must', 'should', 'mustNot', 'ranges',
  'limit', 'offset', 'withinRadius', 'geoHash', 'sortBy',
]);

/** The slips worth naming, with what was probably meant. */
const LIKELY_MEANT: Record<string, string> = {
  range: 'ranges', numericRange: 'ranges', between: 'ranges',
  filter: 'must', filters: 'must', where: 'must', tags: 'must', categories: 'must',
  any: 'should', or: 'should', not: 'mustNot', exclude: 'mustNot',
  sort: 'sortBy', orderBy: 'sortBy', order: 'sortBy',
  radius: 'withinRadius', near: 'withinRadius', geo: 'withinRadius',
  tenant: 'tenantId', size: 'limit', take: 'limit', skip: 'offset',
  total: 'exactTotal', exact: 'exactTotal',
};

function assertKnownSearchOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (KNOWN_SEARCH_OPTIONS.has(key)) {
      continue;
    }
    const meant = LIKELY_MEANT[key];
    throw new PulseIndexQueryError(
      `unknown search option "${key}"` +
        (meant ? `; did you mean "${meant}"?` : '') +
        ` Known options: ${[...KNOWN_SEARCH_OPTIONS].join(', ')}`,
    );
  }
}
