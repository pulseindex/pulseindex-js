export const FilterOperation = {
  MUST: 0,
  SHOULD: 1,
  MUST_NOT: 2,
} as const;

export type FilterOperationCode =
  (typeof FilterOperation)[keyof typeof FilterOperation];

export type EntityId = string | number | bigint;

export interface FilterPredicate {
  op: FilterOperationCode;
  attribute: string;
  /**
   * Which disjunction a SHOULD predicate belongs to. Ignored for MUST and
   * MUST_NOT.
   *
   * Members of a group are OR'd together and the groups are AND'd with each
   * other, so "(red or blue) and (small or medium)" is two groups. Predicates
   * that leave this unset share group 0.
   */
  group?: number;
}

/** Orders a page by a numeric field. */
export interface SortSpec {
  /** Numeric field name, the same one a range would name. */
  field: string;
  /** Largest first when true; smallest first otherwise. */
  descending: boolean;
  /**
   * Order by distance from the query's geo predicate instead of by a field
   * value. `field` is ignored.
   *
   * Ordering is to the centimetre, which is the precision a stored position
   * has. Rows closer together than that tie, and a tie breaks on the entity id
   * so the same query returns the same page.
   */
  byDistance?: boolean;
}

export interface RangePredicate {
  field: string;
  minVal: number;
  maxVal: number;
}

/** A circle, and the position field to measure it against. */
export interface GeoPredicate {
  field: string;
  lat: number;
  lon: number;
  /** Inclusive. 0 means no radius bound, only an origin to measure from. */
  radiusKm: number;
}

export interface SearchQueryRequest {
  filters: FilterPredicate[];
  geo?: GeoPredicate;
  ranges: RangePredicate[];
  limit: number;
  offset: number;
  tenantId: string;
  /** Count every match rather than stopping when the page is full. */
  exactTotal: boolean;
  /** Absent returns matches in entity-id order. */
  sort?: SortSpec;
}

export interface SearchResponse {
  matchedEntityIds: string[];
  totalMatches: number;
  executionTimeUs: number;
  /**
   * Whether `totalMatches` is the real number of matches or the early-exit
   * count from a paged search. A paged search stops as soon as the page is
   * full, which is what makes it cost microseconds, and leaves the total far
   * below the truth. Measured on a million entities: a query with 166,325
   * matches reported 10,866 when asked for a page of 100.
   *
   * Use {@link PulseIndexClient.searchWithTotal} when you need a number you can
   * divide by a page size.
   */
  totalIsExact: boolean;
}

export interface IndexEntityRequest {
  entityId: string;
  numbers: Record<string, number>;
  points: Record<string, GeoPoint>;
  categories: string[];
  tenantId: string;
}

export interface IndexEntityResponse {
  success: boolean;
}

export interface BatchIndexEntitiesRequest {
  entities: IndexEntityRequest[];
}

export interface BatchIndexResponse {
  indexedCount: number;
}

export interface DeleteEntityRequest {
  entityId: string;
  tenantId: string;
}

export interface DeleteResponse {
  success: boolean;
}

export interface BatchDeleteResponse {
  /**
   * How many rows actually changed. Lower than the number of ids sent when
   * some were unknown or already deleted, which is not an error.
   */
  deletedCount: number;
}

export interface RadiusOptions {
  lat: number;
  lng?: number;
  lon?: number;
  radiusKm: number;
  precision?: number;
  /**
   * The position field to measure against, as named in `points` when indexing.
   *
   * Given one, the engine narrows on the geohash cells and then measures the
   * true distance, so the answer holds only what is really inside the circle.
   * Without it the cells are the whole answer, and a union of cells is a
   * superset: measured at a million entities, a 1 km search returned 2,479
   * rows where 1,241 were inside.
   */
  field?: string;
}

export interface SearchRequestOptions {
  tenantId?: string;
  /** Count every match rather than stopping when the page is full. */
  exactTotal?: boolean;
  must?: string | string[];
  should?: string | string[];
  mustNot?: string | string[];
  ranges?: Array<{ field: string; min: number; max: number }>;
  limit?: number;
  offset?: number;
  withinRadius?: RadiusOptions;
  geoHash?: string;
  /**
   * Order the page by a numeric field. `descending` defaults to false.
   *
   * Rows carrying no value for the field sort last in both directions. They
   * still count towards `totalMatches`; they have nothing to be ordered by.
   */
  sortBy?: { field: string; descending?: boolean };
  /**
   * What the person has typed so far, one or several words. Needs records
   * indexed with `Text.indexTokens`. See `QueryBuilder.typeahead`.
   */
  typeahead?: string;
}

export interface EntityAttributes {
  categories?: unknown;
  tags?: unknown;
  numbers?: unknown;
  tenantId?: unknown;
  tenant_id?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  lat?: unknown;
  lng?: unknown;
  lon?: unknown;
  [key: string]: unknown;
}

export interface EntityInput {
  id?: EntityId;
  entityId?: EntityId;
  entity_id?: EntityId;
  attributes?: EntityAttributes;
  categories?: unknown;
  tags?: unknown;
  numbers?: unknown;
  tenantId?: unknown;
  tenant_id?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  lat?: unknown;
  lng?: unknown;
  lon?: unknown;
  [key: string]: unknown;
}

export interface BatchEntityInput {
  id?: EntityId;
  entityId?: EntityId;
  entity_id?: EntityId;
  attributes?: EntityAttributes;
  [key: string]: unknown;
}

/** One position in degrees. The engine packs it; this SDK does not. */
export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface EncodedEntity {
  entityId: string;
  categories: string[];
  /** Positions under your own names. */
  points: Record<string, GeoPoint>;
  /**
   * Numeric fields under your own names. Any name, any integer, any number of
   * them. This replaced a single `price` field the engine named for you.
   */
  numbers: Record<string, number>;
  tenantId: string;
}

export interface PulseIndexClientConfig {
  endpoint?: string;
  host?: string;
  apiKey?: string;
  authorization?: string;
  tenantId?: string;
  timeoutMs?: number;
  ssl?: boolean | string | number;
  rootCerts?: Buffer;
  privateKey?: Buffer;
  certChain?: Buffer;
  protoPath?: string;
  /** Override the bundled `health.proto`. Only needed if the package layout is rewritten. */
  healthProtoPath?: string;
  poolSize?: number;
  channelOptions?: Record<string, unknown>;
}

export const UINT32_MAX = 4_294_967_295;
export const DEFAULT_ENDPOINT = 'localhost:50051';
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_POOL_SIZE = 1;
