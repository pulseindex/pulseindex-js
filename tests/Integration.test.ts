import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionManager,
  FilterOperation,
  GeoHash,
  PulseIndex,
  PulseIndexAuthError,
  PulseIndexClient,
  encodeEntity,
  sslEnabled,
} from '../src';
import * as protoLoader from '@grpc/proto-loader';
import {
  loadEngineProto,
  resolveHealthProtoPath,
  PROTO_LOADER_OPTIONS,
} from '../src/grpc/loadProto';

type MetadataMap = ReturnType<grpc.Metadata['getMap']>;

interface CapturedCall {
  method: string;
  request: Record<string, unknown>;
  metadata: MetadataMap;
}

interface MockEngine {
  port: number;
  calls: CapturedCall[];
  close(): Promise<void>;
}

function metadataObject(metadata: grpc.Metadata): MetadataMap {
  return metadata.getMap();
}

async function startMockEngine(options: {
  searchIds?: string[];
  failAuth?: boolean;
  /**
   * `grpc.health.v1` status this server reports, for both the named service
   * and the empty overall-server key. Defaults to SERVING; 2 is NOT_SERVING.
   */
  servingStatus?: number;
  /** Ids this fake server still holds, for batchDeleteEntities. */
  liveIds?: string[];
  /** Serve no health service at all. */
  omitHealthService?: boolean;
} = {}): Promise<MockEngine> {
  const { service } = loadEngineProto();
  const server = new grpc.Server();
  const calls: CapturedCall[] = [];

  const capture = (
    method: string,
    call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
  ): void => {
    calls.push({
      method,
      request: (call.request ?? {}) as Record<string, unknown>,
      metadata: metadataObject(call.metadata),
    });
  };

  if (!options.omitHealthService) {
    // The health service needs no key, so the mock answers without one.
    const healthDef = protoLoader.loadSync(resolveHealthProtoPath(), PROTO_LOADER_OPTIONS);
    const healthPkg = grpc.loadPackageDefinition(healthDef) as unknown as {
      grpc: { health: { v1: { Health: { service: grpc.ServiceDefinition } } } };
    };
    server.addService(healthPkg.grpc.health.v1.Health.service, {
      check(
        call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
        callback: grpc.sendUnaryData<{ status: number }>,
      ) {
        capture('health.check', call);
        callback(null, { status: options.servingStatus ?? 1 });
      },
    });
  }

  server.addService(service, {
    indexEntity(
      call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: grpc.sendUnaryData<{ success: boolean }>,
    ) {
      if (options.failAuth) {
        callback({
          code: grpc.status.UNAUTHENTICATED,
          details: 'invalid api key',
        });
        return;
      }
      capture('indexEntity', call);
      callback(null, { success: true });
    },
    batchIndexEntities(
      call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: grpc.sendUnaryData<{ indexedCount: number }>,
    ) {
      capture('batchIndexEntities', call);
      const entities = (call.request?.entities as unknown[] | undefined) ?? [];
      callback(null, { indexedCount: entities.length });
    },
    deleteEntity(
      call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: grpc.sendUnaryData<{ success: boolean }>,
    ) {
      capture('deleteEntity', call);
      callback(null, { success: true });
    },
    batchDeleteEntities(
      call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: grpc.sendUnaryData<{ deletedCount: number }>,
    ) {
      capture('batchDeleteEntities', call);
      const ids = (call.request?.entityIds as string[] | undefined) ?? [];
      // Only ids still held count, so a test can tell the number asked about
      // from the number that actually changed.
      const live = new Set(options.liveIds ?? ids);
      const changed = new Set(ids.filter((id) => live.has(id)));
      callback(null, { deletedCount: changed.size });
    },
    search(
      call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>,
      callback: grpc.sendUnaryData<{
        matchedEntityIds: string[];
        totalMatches: number;
        executionTimeUs: string;
        totalIsExact: boolean;
      }>,
    ) {
      capture('search', call);
      const ids = options.searchIds ?? ['1001'];
      const req = (call.request ?? {}) as { exactTotal?: boolean; limit?: number };
      // The total is exact when the caller asked for it, or when there is no
      // page to stop at.
      const counted = Boolean(req.exactTotal) || Number(req.limit ?? 0) === 0;
      callback(null, {
        matchedEntityIds: ids,
        totalMatches: counted ? ids.length * 10 : ids.length,
        executionTimeUs: '42',
        totalIsExact: counted,
      });
    },
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boundPort);
    });
  });

  return {
    port,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.tryShutdown((error) => {
          if (error) {
            server.forceShutdown();
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

describe('PulseIndex client integration', () => {
  const clients: PulseIndexClient[] = [];
  const engines: MockEngine[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    for (const engine of engines.splice(0)) {
      await engine.close();
    }
  });

  it('attaches x-api-key and Bearer authorization metadata', () => {
    const connection = new ConnectionManager({
      endpoint: 'localhost:50051',
      apiKey: 'secret-key',
    });

    const metadata = connection.createMetadata().getMap();
    expect(metadata['x-api-key']).toBe('secret-key');
    expect(metadata.authorization).toBe('Bearer secret-key');
    connection.close();
  });

  it('prefers an explicit authorization token when provided', () => {
    const connection = new ConnectionManager({
      endpoint: 'localhost:50051',
      apiKey: 'secret-key',
      authorization: 'other-token',
    });

    const metadata = connection.createMetadata().getMap();
    expect(metadata['x-api-key']).toBe('secret-key');
    expect(metadata.authorization).toBe('Bearer other-token');
    connection.close();
  });

  it('treats string false as plaintext SSL', () => {
    expect(sslEnabled({ ssl: 'false' })).toBe(false);
    expect(sslEnabled({ ssl: '0' })).toBe(false);
    expect(sslEnabled({ ssl: false })).toBe(false);
    expect(sslEnabled({ ssl: true })).toBe(true);
    expect(sslEnabled({ ssl: 'true' })).toBe(true);
    expect(sslEnabled({ ssl: '1' })).toBe(true);
    expect(sslEnabled({})).toBe(false);
  });

  it('encodes attributes into namespaced tags and geo tags', () => {
    const encoded = encodeEntity('1001', {
      categories: ['feature:pool'],
      status: 'listed',
      amenities: ['parking', 'gym'],
      numbers: { price_cents: 150000, bedrooms: 3 },
      // A top-level scalar is a tag like any other, whatever its name.
      price: 1500,
      lat: 42.6,
      lng: -5.6,
      tenantId: 'acme',
    });

    expect(encoded.entityId).toBe('1001');
    expect(encoded.numbers).toEqual({ price_cents: 150000, bedrooms: 3 });
    expect(encoded.tenantId).toBe('acme');
    expect(encoded.categories).toEqual(
      expect.arrayContaining([
        'feature:pool',
        'status:listed',
        'amenities:parking',
        'amenities:gym',
        'price:1500',
        ...GeoHash.encodeMultiTags(42.6, -5.6),
      ]),
    );
  });

  // A position in `points` is the shape the README leads with, so it has to
  // carry the tags withinRadius() asks for.
  it('tags a position given as points, not only as lat/lng', () => {
    const encoded = encodeEntity('1001', {
      categories: ['status:available'],
      points: { where: { lat: 41.0082, lon: 28.9784 } },
    });

    for (const tag of GeoHash.encodeMultiTags(41.0082, 28.9784)) {
      expect(encoded.categories).toContain(tag);
    }
    expect(encoded.points).toEqual({ where: { lat: 41.0082, lon: 28.9784 } });
  });

  it('tags every position a record carries', () => {
    const encoded = encodeEntity('1002', {
      points: {
        pickup: { lat: 41.0082, lon: 28.9784 },
        dropoff: { lat: 41.0082, lon: 28.9784 },
      },
    });

    for (const [lat, lon] of [
      [41.0082, 28.9784],
      [41.0082, 28.9784],
    ] as const) {
      for (const tag of GeoHash.encodeMultiTags(lat, lon)) {
        expect(encoded.categories).toContain(tag);
      }
    }
  });

  it('does not tag the same position twice when it arrives in both shapes', () => {
    const encoded = encodeEntity('1003', {
      points: { where: { lat: 42.6, lon: -5.6 } },
      lat: 42.6,
      lng: -5.6,
    });

    expect(encoded.categories).toEqual([...new Set(encoded.categories)]);
    expect(encoded.categories.sort()).toEqual(GeoHash.encodeMultiTags(42.6, -5.6).sort());
  });

  it('gives a record with no position no geo tag', () => {
    const encoded = encodeEntity('1004', { categories: ['status:available'] });

    expect(encoded.categories).toEqual(['status:available']);
  });

  it('sends search and index RPCs over a mocked gRPC engine', async () => {
    const engine = await startMockEngine({ searchIds: ['1001', '1003'] });
    engines.push(engine);

    const client = new PulseIndex({
      endpoint: `127.0.0.1:${engine.port}`,
      apiKey: 'dev-key',
      tenantId: 'acme',
      timeoutMs: 2000,
    });
    clients.push(client);

    const indexed = await client.index('1001', {
      categories: ['feature:pool'],
      amenities: ['parking'],
      numbers: { price_cents: 150000, bedrooms: 3 },
      lat: 41.0082,
      lng: 28.9784,
    });
    expect(indexed.success).toBe(true);

    const batch = await client.batchIndex([
      { id: 1002, attributes: { categories: ['feature:garden'], price: 900 } },
      { entityId: 1003, categories: ['feature:pool'], price: 2000 },
    ]);
    expect(batch.indexedCount).toBe(2);

    const result = await client.search(
      client
        .query()
        .must('feature:pool')
        .should(['category:villa', 'category:apartment'])
        .mustNot('status:sold')
        .range('price', 1000, 1800)
        .withinRadius({ lat: 41.0082, lng: 28.9784, radiusKm: 5 })
        .limit(50),
    );

    expect(result.matchedEntityIds).toEqual(['1001', '1003']);
    expect(result.totalMatches).toBe(2);
    expect(result.executionTimeUs).toBe(42);

    const deleted = await client.delete('1001');
    expect(deleted.success).toBe(true);
    expect(await client.health()).toBe(true);

    const headers = engine.calls[0]?.metadata;
    expect(headers?.['x-api-key']).toBe('dev-key');
    expect(headers?.authorization).toBe('Bearer dev-key');

    const indexRequest = engine.calls.find((call) => call.method === 'indexEntity')?.request;
    expect(indexRequest?.entityId).toBe('1001');
    expect(indexRequest?.tenantId).toBe('acme');
    // int64 arrives as a string, the same as entityId does: the loader is set
    // to `longs: String` so a value past 2^53 survives the trip intact.
    expect(indexRequest?.numbers).toEqual({ price_cents: '150000', bedrooms: '3' });
    expect(indexRequest?.categories).toEqual(
      expect.arrayContaining(['feature:pool', 'amenities:parking']),
    );

    const searchRequest = engine.calls.find((call) => call.method === 'search')?.request;
    expect(searchRequest?.tenantId).toBe('acme');
    expect(searchRequest?.limit).toBe(50);
    const filters =
      (searchRequest?.filters as Array<{ op: number; attribute: string; group: number }>) ?? [];
    // group 0 is what a predicate that names no disjunction sends.
    expect(filters[0]).toEqual({ op: FilterOperation.MUST, attribute: 'feature:pool', group: 0 });
    expect(filters.some((filter) => filter.attribute === 'category:villa')).toBe(true);
    expect(filters.some((filter) => filter.attribute.startsWith('geo:'))).toBe(true);
  });

  it('accepts plain SearchRequestOptions for search', async () => {
    const engine = await startMockEngine({ searchIds: ['7'] });
    engines.push(engine);

    const client = PulseIndexClient.create(`127.0.0.1:${engine.port}`, 'k');
    clients.push(client);

    const result = await client.search({
      tenantId: 't1',
      must: 'feature:pool',
      limit: 10,
    });

    expect(result.matchedEntityIds).toEqual(['7']);
    const searchRequest = engine.calls.find((call) => call.method === 'search')?.request;
    expect(searchRequest?.tenantId).toBe('t1');
    expect(searchRequest?.limit).toBe(10);
  });

  it('wraps unauthenticated gRPC status as PulseIndexAuthError', async () => {
    const engine = await startMockEngine({ failAuth: true });
    engines.push(engine);

    const client = new PulseIndexClient({
      endpoint: `127.0.0.1:${engine.port}`,
      apiKey: 'bad',
      timeoutMs: 2000,
    });
    clients.push(client);

    await expect(client.index('1', { categories: ['x'] })).rejects.toBeInstanceOf(PulseIndexAuthError);
  });

  it('reports unhealthy while the service is not serving', async () => {
    // NOT_SERVING on grpc.health.v1, which needs no credential.
    const engine = await startMockEngine({ servingStatus: 2 });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    expect(await client.servingStatus()).toBe(2);
    expect(await client.health()).toBe(false);
  });

  it('reports healthy when the engine is reachable and serving', async () => {
    const engine = await startMockEngine({ servingStatus: 1 });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    expect(await client.health()).toBe(true);
  });

  it('reports unhealthy against an engine with no health service', async () => {
    // UNIMPLEMENTED: the SDK cannot tell whether it is serving, so false.
    const engine = await startMockEngine({ omitHealthService: true });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    expect(await client.health()).toBe(false);
  });

  it('sends every id of a batch delete in one call', async () => {
    const engine = await startMockEngine({});
    engines.push(engine);
    const client = new PulseIndexClient({
      endpoint: `127.0.0.1:${engine.port}`,
      apiKey: 'dev-key',
      tenantId: 'acme',
    });
    clients.push(client);

    const result = await client.batchDelete([1001, '1002', 1003]);

    expect(result.deletedCount).toBe(3);
    const calls = engine.calls.filter((call) => call.method === 'batchDeleteEntities');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.entityIds).toEqual(['1001', '1002', '1003']);
    expect(calls[0]?.request.tenantId).toBe('acme');
  });

  it('reports the rows that changed, not the ids that were sent', async () => {
    // Deleting ids that are already gone is not an error, and the caller has to
    // be able to tell the difference, a retry of a page that half-applied
    // reports the smaller number rather than failing.
    const engine = await startMockEngine({ liveIds: ['1001'] });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    const result = await client.batchDelete([1001, 1002, 1003]);
    expect(result.deletedCount).toBe(1);
  });

  it('names the offending element when an id is not a valid uint64', async () => {
    const engine = await startMockEngine({});
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    await expect(client.batchDelete([1001, -5, 1003])).rejects.toThrow(/entityIds\[1\]/);
    expect(engine.calls.filter((c) => c.method === 'batchDeleteEntities')).toHaveLength(0);
  });

  it('sends an empty batch delete without inventing a count', async () => {
    const engine = await startMockEngine({ liveIds: [] });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    const result = await client.batchDelete([]);
    expect(result.deletedCount).toBe(0);
  });

  // A paged total may be a lower bound, and the response says which.
  it('reads exactness off the wire instead of guessing it from the limit', async () => {
    const engine = await startMockEngine({ searchIds: ['1', '2', '3'] });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    const paged = await client.search(client.query().must('a:b').limit(10));
    expect(paged.totalIsExact).toBe(false);
    expect(paged.totalMatches).toBe(3);

    const counted = await client.search(client.query().must('a:b').limit(0));
    expect(counted.totalIsExact).toBe(true);
    expect(counted.totalMatches).toBe(30);
  });

  it('gets a page and a true total in one request, not two', async () => {
    const engine = await startMockEngine({ searchIds: ['1', '2', '3'] });
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    const both = await client.searchWithTotal(client.query().must('a:b').limit(10));

    expect(both.matchedEntityIds).toEqual(['1', '2', '3']);
    expect(both.totalIsExact).toBe(true);
    // The whole set, not the part the page saw.
    expect(both.totalMatches).toBe(30);
    // One call.
    expect(engine.calls.filter((c) => c.method === 'search')).toHaveLength(1);
    expect(engine.calls[0]?.request?.exactTotal).toBe(true);
  });

  it('still sends one call when the query already counted everything', async () => {
    const engine = await startMockEngine({});
    engines.push(engine);
    const client = new PulseIndexClient({ endpoint: `127.0.0.1:${engine.port}`, apiKey: 'dev-key' });
    clients.push(client);

    await client.searchWithTotal(client.query().must('a:b').limit(0));
    expect(engine.calls.filter((c) => c.method === 'search')).toHaveLength(1);
  });

  it('reports unhealthy when the engine is unreachable', async () => {
    const client = new PulseIndexClient({
      endpoint: '127.0.0.1:1',
      apiKey: 'dev-key',
      timeoutMs: 500,
    });
    clients.push(client);
    expect(await client.health()).toBe(false);
  });
});
