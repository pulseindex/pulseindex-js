import type * as grpc from '@grpc/grpc-js';
import { QueryBuilder, type QueryExecutor } from '../builder/QueryBuilder';
import {
  PulseIndexError,
  PulseIndexConnectionError,
} from '../errors/PulseIndexError';
import {
  type BatchDeleteResponse,
  type BatchEntityInput,
  type BatchIndexResponse,
  type DeleteResponse,
  type EncodedEntity,
  type EntityAttributes,
  type EntityId,
  type EntityInput,
  type IndexEntityRequest,
  type IndexEntityResponse,
  type PulseIndexClientConfig,
  type SearchRequestOptions,
  type SearchResponse,
} from '../types';
import { ConnectionManager } from './ConnectionManager';
import { encodeEntity, toUint64String } from './encodeEntity';
import { SERVING_STATUS, type SearchEngineServiceClient } from '../grpc/loadProto';

export class PulseIndexClient implements QueryExecutor {
  readonly connection: ConnectionManager;

  constructor(config: PulseIndexClientConfig = {}) {
    this.connection = new ConnectionManager(config);
  }

  static create(
    endpoint: string,
    apiKey?: string,
    ssl?: boolean,
    extra: Omit<PulseIndexClientConfig, 'endpoint' | 'apiKey' | 'ssl'> = {},
  ): PulseIndexClient {
    return new PulseIndexClient({
      ...extra,
      endpoint,
      apiKey,
      ssl,
    });
  }

  static query(): QueryBuilder {
    return new QueryBuilder();
  }

  query(): QueryBuilder {
    return new QueryBuilder(this);
  }

  async search(query: QueryBuilder | SearchRequestOptions): Promise<SearchResponse> {
    const builder =
      query instanceof QueryBuilder
        ? query
        : QueryBuilder.fromOptions(query, this);

    const raw = await this.unary<SearchResponseWire>(
      (stub, metadata, options, callback) =>
        stub.search(builder.toRequest(this.connection.tenantId), metadata, options, callback),
    );

    return {
      matchedEntityIds: (raw.matchedEntityIds ?? []).map((id) => String(id)),
      totalMatches: Number(raw.totalMatches ?? 0),
      executionTimeUs: Number(raw.executionTimeUs ?? 0),
      // As the engine reports it.
      totalIsExact: Boolean(raw.totalIsExact),
    };
  }

  /**
   * A page of ids together with the exact number of matches, in one request.
   * Use it when you show "page 1 of N": a paged search's own total may be a
   * lower bound.
   */
  async searchWithTotal(
    query: QueryBuilder | SearchRequestOptions,
  ): Promise<SearchResponse> {
    const builder = query instanceof QueryBuilder ? query : QueryBuilder.fromOptions(query, this);
    return this.search(builder.exactTotal());
  }

  async index(
    entityIdOrInput: EntityId | EntityInput,
    attributes: EntityAttributes = {},
  ): Promise<IndexEntityResponse> {
    const encoded = encodeEntity(entityIdOrInput, attributes, {
      tenantId: this.connection.tenantId,
    });
    const raw = await this.unary<{ success?: boolean }>(
      (stub, metadata, options, callback) =>
        stub.indexEntity(toIndexRequest(encoded), metadata, options, callback),
    );
    return { success: Boolean(raw.success) };
  }

  /**
   * Index one record, with the PHP client's parameters in its order.
   * `index()` is the usual call; this mirrors the PHP signature.
   *
   * `numbers` are yours to name: `{price_cents: 45000, bedrooms: 3}`.
   */
  async indexEntity(
    entityId: EntityId,
    categories: string[] = [],
    numbers: Record<string, number> = {},
    points: Record<string, { lat: number; lon: number }> = {},
    tenantId = '',
  ): Promise<boolean> {
    const response = await this.index({
      entityId,
      categories,
      numbers,
      points,
      tenantId: tenantId || this.connection.tenantId,
    });
    return response.success;
  }

  async batchIndex(
    entities: Array<EntityInput | BatchEntityInput>,
  ): Promise<BatchIndexResponse> {
    const requests = entities.map((entity) =>
      toIndexRequest(
        encodeEntity(entity, {}, { tenantId: this.connection.tenantId }),
      ),
    );

    const raw = await this.unary<{ indexedCount?: number | string }>(
      (stub, metadata, options, callback) =>
        stub.batchIndexEntities({ entities: requests }, metadata, options, callback),
    );

    return { indexedCount: Number(raw.indexedCount ?? 0) };
  }

  async delete(entityId: EntityId, tenantId?: string): Promise<DeleteResponse> {
    const raw = await this.unary<{ success?: boolean }>(
      (stub, metadata, options, callback) =>
        stub.deleteEntity(
          {
            entityId: toUint64String(entityId, 'entityId'),
            tenantId: tenantId ?? this.connection.tenantId,
          },
          metadata,
          options,
          callback,
        ),
    );
    return { success: Boolean(raw.success) };
  }

  async deleteEntity(entityId: EntityId, tenantId = ''): Promise<boolean> {
    const response = await this.delete(entityId, tenantId || this.connection.tenantId);
    return response.success;
  }

  /**
   * Delete many entities in one call.
   *
   * Send ids in pages of up to 10,000; a larger batch is refused by name
   * rather than truncated.
   *
   * Ids that are unknown or already deleted are skipped, so retrying a page
   * that half-applied is safe. `deletedCount` is the number of rows that
   * actually changed, which is lower than `entityIds.length` whenever some of
   * them were already gone.
   *
   * ```ts
   * for (const page of pages(allIds, 10_000)) {
   *   await client.batchDelete(page);
   * }
   * ```
   */
  async batchDelete(
    entityIds: readonly EntityId[],
    tenantId?: string,
  ): Promise<BatchDeleteResponse> {
    const ids = entityIds.map((id, i) => toUint64String(id, `entityIds[${i}]`));

    const raw = await this.unary<{ deletedCount?: number | string }>(
      (stub, metadata, options, callback) =>
        stub.batchDeleteEntities(
          {
            entityIds: ids,
            tenantId: tenantId ?? this.connection.tenantId,
          },
          metadata,
          options,
          callback,
        ),
    );

    return { deletedCount: Number(raw.deletedCount ?? 0) };
  }

  /**
   * True only when the engine can serve reads.
   *
   * Asks `grpc.health.v1.Health`, which needs no particular scope and tracks
   * whether the service can currently answer queries. So this distinguishes a
   * reachable-but-unavailable service from a healthy one.
   *
   * Returns `false` rather than throwing, so unreachable and unavailable look
   * the same here. Use {@link servingStatus} to tell them apart.
   */
  async health(): Promise<boolean> {
    try {
      await this.connection.waitForReady();
      const status = await this.servingStatus();
      return status === SERVING_STATUS.SERVING;
    } catch {
      return false;
    }
  }

  /**
   * Raw `grpc.health.v1` serving status for a service name.
   *
   * Defaults to `''`, the overall-server key defined by the health spec. The
   * service answers for both that and its named service.
   */
  async servingStatus(service = ''): Promise<number> {
    const stub = this.connection.getHealthStub();
    return new Promise<number>((resolve, reject) => {
      stub.check(
        { service },
        this.connection.createMetadata(),
        this.connection.createCallOptions(),
        (error, response) => {
          if (error) {
            reject(PulseIndexError.fromGrpc(error));
            return;
          }
          resolve(response?.status ?? SERVING_STATUS.UNKNOWN);
        },
      );
    });
  }




  close(): void {
    this.connection.close();
  }

  private unary<T>(
    invoke: (
      stub: SearchEngineServiceClient,
      metadata: grpc.Metadata,
      options: grpc.CallOptions,
      callback: grpc.requestCallback<unknown>,
    ) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let stub: SearchEngineServiceClient;
      try {
        stub = this.connection.getStub();
      } catch (error) {
        reject(
          error instanceof PulseIndexError
            ? error
            : new PulseIndexConnectionError('Failed to acquire a gRPC channel.', {
                cause: error,
              }),
        );
        return;
      }

      invoke(
        stub,
        this.connection.createMetadata(),
        this.connection.createCallOptions(),
        (error, response) => {
          if (error) {
            reject(PulseIndexError.fromGrpc(error));
            return;
          }
          if (response === undefined || response === null) {
            reject(new PulseIndexError('Empty gRPC response.'));
            return;
          }
          resolve(response as T);
        },
      );
    });
  }
}

export class PulseIndex extends PulseIndexClient {}

interface SearchResponseWire {
  totalIsExact?: boolean;
  matchedEntityIds?: Array<string | number>;
  totalMatches?: number | string;
  executionTimeUs?: number | string;
}

function toIndexRequest(encoded: EncodedEntity): IndexEntityRequest {
  return {
    entityId: encoded.entityId,
    numbers: encoded.numbers,
    points: encoded.points,
    categories: encoded.categories,
    tenantId: encoded.tenantId,
  };
}
