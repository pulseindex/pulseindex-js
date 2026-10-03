import * as grpc from '@grpc/grpc-js';
import { PulseIndexConnectionError } from '../errors/PulseIndexError';
import {
  DEFAULT_ENDPOINT,
  DEFAULT_POOL_SIZE,
  DEFAULT_TIMEOUT_MS,
  type PulseIndexClientConfig,
} from '../types';
import {
  loadEngineProto,
  loadHealthProto,
  type HealthClient,
  type SearchEngineServiceClient,
} from '../grpc/loadProto';

const DEFAULT_CHANNEL_OPTIONS: Record<string, unknown> = {
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 5_000,
  'grpc.keepalive_permit_without_calls': 1,
  'grpc.http2.min_time_between_pings_ms': 10_000,
  'grpc.max_receive_message_length': 16 * 1024 * 1024,
  'grpc.max_send_message_length': 16 * 1024 * 1024,
};

export function resolveEndpoint(config: PulseIndexClientConfig): string {
  return (
    config.endpoint ??
    config.host ??
    process.env.PULSEINDEX_ENDPOINT ??
    process.env.PULSEINDEX_HOST ??
    DEFAULT_ENDPOINT
  );
}

export function resolveApiKey(config: PulseIndexClientConfig): string | undefined {
  const key = config.apiKey ?? process.env.PULSEINDEX_API_KEY ?? undefined;
  if (typeof key !== 'string' || key.trim().length === 0) {
    return undefined;
  }
  return key.trim();
}

export function resolveAuthorization(config: PulseIndexClientConfig): string | undefined {
  const token = config.authorization ?? process.env.PULSEINDEX_AUTHORIZATION ?? undefined;
  if (typeof token !== 'string' || token.trim().length === 0) {
    return undefined;
  }
  return token.trim();
}

export function resolveTenantId(config: PulseIndexClientConfig): string {
  return config.tenantId ?? process.env.PULSEINDEX_TENANT_ID ?? '';
}

export function sslEnabled(config: PulseIndexClientConfig): boolean {
  if (config.ssl !== undefined) {
    return parseBoolean(config.ssl);
  }
  const env = process.env.PULSEINDEX_SSL;
  if (env === undefined || env === '') {
    return false;
  }
  return parseBoolean(env);
}

function parseBoolean(value: boolean | string | number): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export class ConnectionManager {
  readonly endpoint: string;
  readonly tenantId: string;
  readonly timeoutMs: number;
  readonly ssl: boolean;

  private readonly apiKey?: string;
  private readonly authorization?: string;
  private readonly clients: SearchEngineServiceClient[] = [];
  private cursor = 0;
  private closed = false;

  // Kept so the health stub reuses the same address, credentials and options,
  // and so the same connection.
  private readonly credentials!: grpc.ChannelCredentials;
  private readonly channelOptions!: Record<string, unknown>;
  private readonly healthProtoPath?: string;
  private healthStub?: HealthClient;

  constructor(config: PulseIndexClientConfig = {}) {
    this.endpoint = resolveEndpoint(config);
    this.tenantId = resolveTenantId(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ssl = sslEnabled(config);
    this.apiKey = resolveApiKey(config);
    this.authorization = resolveAuthorization(config);

    const poolSize = Math.max(1, Math.floor(config.poolSize ?? DEFAULT_POOL_SIZE));
    const credentials = this.createCredentials(config);
    const { SearchEngineService } = loadEngineProto(config.protoPath);
    const channelOptions = {
      ...DEFAULT_CHANNEL_OPTIONS,
      ...(config.channelOptions ?? {}),
    };

    for (let i = 0; i < poolSize; i += 1) {
      this.clients.push(new SearchEngineService(this.endpoint, credentials, channelOptions));
    }

    this.credentials = credentials;
    this.channelOptions = channelOptions;
    this.healthProtoPath = config.healthProtoPath;
  }

  /**
   * `grpc.health.v1.Health` stub, created on first use.
   *
   * A separate service from the query API, and unauthenticated: the health
   * protocol needs no scope, so it works with any key or none.
   */
  getHealthStub(): HealthClient {
    this.assertOpen();
    if (!this.healthStub) {
      const Health = loadHealthProto(this.healthProtoPath);
      this.healthStub = new Health(this.endpoint, this.credentials, this.channelOptions);
    }
    return this.healthStub;
  }

  getStub(): SearchEngineServiceClient {
    this.assertOpen();
    const stub = this.clients[this.cursor % this.clients.length];
    this.cursor += 1;
    if (!stub) {
      throw new PulseIndexConnectionError('PulseIndex gRPC channel pool is empty.');
    }
    return stub;
  }

  createMetadata(): grpc.Metadata {
    const metadata = new grpc.Metadata();

    if (this.apiKey) {
      metadata.set('x-api-key', this.apiKey);
    }

    const bearer = this.authorization
      ? this.authorization.toLowerCase().startsWith('bearer ')
        ? this.authorization
        : `Bearer ${this.authorization}`
      : this.apiKey
        ? `Bearer ${this.apiKey}`
        : undefined;

    if (bearer) {
      metadata.set('authorization', bearer);
    }

    return metadata;
  }

  createCallOptions(): grpc.CallOptions {
    return {
      deadline: Date.now() + this.timeoutMs,
    };
  }

  async waitForReady(timeoutMs = this.timeoutMs): Promise<void> {
    this.assertOpen();
    const deadline = new Date(Date.now() + timeoutMs);
    await Promise.all(
      this.clients.map(
        (client) =>
          new Promise<void>((resolve, reject) => {
            client.waitForReady(deadline, (error) => {
              if (error) {
                reject(
                  new PulseIndexConnectionError(
                    `Unable to connect to PulseIndex at ${this.endpoint}: ${error.message}`,
                    { cause: error, code: 'UNAVAILABLE' },
                  ),
                );
                return;
              }
              resolve();
            });
          }),
      ),
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const client of this.clients) {
      client.close();
    }
    this.clients.length = 0;
    this.healthStub?.close();
    this.healthStub = undefined;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PulseIndexConnectionError('PulseIndex client has been closed.');
    }
  }

  private createCredentials(config: PulseIndexClientConfig): grpc.ChannelCredentials {
    if (!this.ssl) {
      return grpc.credentials.createInsecure();
    }

    return grpc.credentials.createSsl(
      config.rootCerts ?? null,
      config.privateKey ?? null,
      config.certChain ?? null,
    );
  }
}
