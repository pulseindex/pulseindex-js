export { PulseIndexClient, PulseIndex } from './client/PulseIndexClient';
export { ConnectionManager, sslEnabled } from './client/ConnectionManager';
export { QueryBuilder, DEFAULT_LIMIT } from './builder/QueryBuilder';
export { GeoHash } from './geo/GeoHash';
export { Text, verifyIndex as verifyTextIndex } from './text/Text';
export type { TokenizerCheck, TextSearchExecutor } from './text/Text';
export { encodeEntity, toUint64String } from './client/encodeEntity';
export {
  PulseIndexError,
  PulseIndexConnectionError,
  PulseIndexAuthError,
  PulseIndexQueryError,
} from './errors/PulseIndexError';
export { FilterOperation } from './types';
export { SERVING_STATUS } from './grpc/loadProto';
export type {
  BatchDeleteResponse,
  BatchEntityInput,
  BatchIndexResponse,
  DeleteResponse,
  EncodedEntity,
  EntityAttributes,
  EntityId,
  EntityInput,
  FilterPredicate,
  IndexEntityRequest,
  IndexEntityResponse,
  PulseIndexClientConfig,
  RadiusOptions,
  RangePredicate,
  SearchQueryRequest,
  SearchRequestOptions,
  SearchResponse,
  SortSpec,
} from './types';

import { PulseIndex } from './client/PulseIndexClient';

export default PulseIndex;
