import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { diffProtoSubset, parseProtoSchema, type ProtoSchema } from '../scripts/protoSchema.mjs';

/**
 * Guard against silent proto drift.
 *
 * The SDK loads `proto/engine.proto` at runtime and reads fields by name, with
 * `?? default` fallbacks throughout `PulseIndexClient`. That means a field the
 * engine renames, renumbers or removes does not fail loudly, it yields the
 * fallback, and the client reports plausible-looking wrong data. Exactly that
 * class of drift left `needs_full_reindex` unobserved while `health()` reported
 * a degraded engine as healthy.
 *
 * The fixture below is the schema this SDK is written against, in full. Any
 * change to the vendored proto fails here until the fixture is updated, which
 * puts the change in the pull-request diff where it can be reviewed rather than
 * absorbed silently.
 *
 * It does NOT prove the vendored copy matches the engine, nothing inside this
 * repository can, since the engine is a separate private repository. Use
 * `npm run check:proto` with the engine checked out for that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(HERE, '..', 'proto', 'engine.proto');

const EXPECTED: ProtoSchema = {
  rpcs: [
    'IndexEntity(IndexEntityRequest) -> IndexEntityResponse',
    'BatchIndexEntities(BatchIndexEntitiesRequest) -> BatchIndexEntitiesResponse',
    'DeleteEntity(DeleteEntityRequest) -> DeleteEntityResponse',
    'BatchDeleteEntities(BatchDeleteEntitiesRequest) -> BatchDeleteEntitiesResponse',
    'Search(SearchQueryRequest) -> SearchQueryResponse',
  ],
  messages: {
    IndexEntityRequest: [
      '1:uint64 entity_id',
      '6:map<string, int64> numbers',
      '7:map<string, GeoPoint> points',
      '4:repeated string categories',
      '5:string tenant_id',
    ],
    IndexEntityResponse: ['1:bool success'],
    BatchIndexEntitiesRequest: ['1:repeated IndexEntityRequest entities'],
    BatchIndexEntitiesResponse: ['1:uint32 indexed_count'],
    DeleteEntityRequest: ['1:uint64 entity_id', '2:string tenant_id'],
    DeleteEntityResponse: ['1:bool success'],
    BatchDeleteEntitiesRequest: ['1:repeated uint64 entity_ids', '2:string tenant_id'],
    BatchDeleteEntitiesResponse: ['1:uint32 deleted_count'],
    FilterPredicate: ['1:Operation op', '2:string attribute', '3:uint32 group'],
    RangePredicate: ['1:string field', '2:int64 min_val', '3:int64 max_val'],
    GeoPoint: ['1:double lat', '2:double lon'],
    GeoPredicate: [
      '1:string field',
      '2:double lat',
      '3:double lon',
      '4:double radius_km',
    ],
    SortSpec: ['1:string field', '2:bool descending', '3:bool by_distance'],
    SearchQueryRequest: [
      '2:repeated FilterPredicate filters',
      '3:repeated RangePredicate ranges',
      '4:uint32 limit',
      '5:uint32 offset',
      '6:string tenant_id',
      '7:SortSpec sort',
      '8:bool exact_total',
      '9:GeoPredicate geo',
    ],
    SearchQueryResponse: [
      '1:repeated uint64 matched_entity_ids',
      '2:uint32 total_matches',
      '3:uint64 execution_time_us',
      '4:bool total_is_exact',
    ],
  },
  enums: {
    'FilterPredicate.Operation': ['MUST=0', 'SHOULD=1', 'MUST_NOT=2'],
  },
};

// The guard has to tell a deliberate trim from a forgotten one. diffProtoSubset
// only ever walked the vendored declarations, so anything the engine had and
// the copy lacked passed silently. Verified before this: deleting
// BatchDeleteEntities from the vendored proto left `npm run check:proto` green.
describe('engine-to-vendored omissions', () => {
  const engine = parseProtoSchema(`
    service SearchEngineService {
      rpc Search (SearchQueryRequest) returns (SearchQueryResponse);
      rpc BatchDeleteEntities (BatchDeleteEntitiesRequest) returns (BatchDeleteEntitiesResponse);
      rpc GetRecoveryState (GetRecoveryStateRequest) returns (GetRecoveryStateResponse);
    }
    message SearchQueryRequest { uint32 limit = 1; }
    message SearchQueryResponse { uint32 total_matches = 1; }
    message BatchDeleteEntitiesRequest { repeated uint64 entity_ids = 1; }
    message BatchDeleteEntitiesResponse { uint32 deleted_count = 1; }
    message GetRecoveryStateRequest { }
    message GetRecoveryStateResponse { uint64 indexed_count = 2; }
  `);

  const withoutOperatorRpcs = `
    service SearchEngineService {
      rpc Search (SearchQueryRequest) returns (SearchQueryResponse);
      rpc BatchDeleteEntities (BatchDeleteEntitiesRequest) returns (BatchDeleteEntitiesResponse);
    }
    message SearchQueryRequest { uint32 limit = 1; }
    message SearchQueryResponse { uint32 total_matches = 1; }
    message BatchDeleteEntitiesRequest { repeated uint64 entity_ids = 1; }
    message BatchDeleteEntitiesResponse { uint32 deleted_count = 1; }
  `;

  it('reports a customer RPC missing from the vendored copy', () => {
    const vendored = parseProtoSchema(`
      service SearchEngineService {
        rpc Search (SearchQueryRequest) returns (SearchQueryResponse);
      }
      message SearchQueryRequest { uint32 limit = 1; }
      message SearchQueryResponse { uint32 total_matches = 1; }
    `);
    const diff = diffProtoSubset(engine, vendored);
    expect(diff.join('\n')).toContain('BatchDeleteEntities');
  });

  it('accepts the operator RPCs being left out, and only those', () => {
    expect(diffProtoSubset(engine, parseProtoSchema(withoutOperatorRpcs))).toEqual([]);
  });
});

describe('vendored engine.proto schema', () => {
  const actual = parseProtoSchema(readFileSync(PROTO_PATH, 'utf8'));

  it('declares exactly the RPCs this SDK implements', () => {
    expect(actual.rpcs).toEqual(EXPECTED.rpcs);
  });

  it('declares exactly the messages this SDK expects', () => {
    expect(Object.keys(actual.messages).sort()).toEqual(Object.keys(EXPECTED.messages).sort());
  });

  it('declares every field with the expected number and type', () => {
    // Per-message assertions so a failure names the message that drifted
    // instead of dumping the whole schema.
    for (const [message, fields] of Object.entries(EXPECTED.messages)) {
      expect(actual.messages[message], `message ${message} is missing`).toBeDefined();
      expect(actual.messages[message], `field drift in message ${message}`).toEqual(fields);
    }
  });

  it('declares the expected enum values', () => {
    expect(actual.enums).toEqual(EXPECTED.enums);
  });

  it('still carries the fields the client reads back', () => {
    // PulseIndexClient reads these by name with `?? default` fallbacks, so a
    // rename or removal upstream would be silent at runtime rather than loud.
    const search = actual.messages.SearchQueryResponse ?? [];
    for (const field of [
      '1:repeated uint64 matched_entity_ids',
      '2:uint32 total_matches',
      '3:uint64 execution_time_us',
    ]) {
      expect(search, `SearchQueryResponse lost ${field}`).toContain(field);
    }
  });
});
