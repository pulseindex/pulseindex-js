import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { PulseIndexError } from '../errors/PulseIndexError';

export const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: Number,
  defaults: true,
  oneofs: true,
};

export interface SearchEngineServiceClient extends grpc.Client {
  indexEntity(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<unknown>,
  ): grpc.ClientUnaryCall;
  batchIndexEntities(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<unknown>,
  ): grpc.ClientUnaryCall;
  deleteEntity(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<unknown>,
  ): grpc.ClientUnaryCall;
  batchDeleteEntities(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<unknown>,
  ): grpc.ClientUnaryCall;
  search(
    request: unknown,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<unknown>,
  ): grpc.ClientUnaryCall;
}

export type SearchEngineServiceClientCtor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: object,
) => SearchEngineServiceClient;

export interface LoadedEngineProto {
  protoPath: string;
  SearchEngineService: SearchEngineServiceClientCtor;
  service: grpc.ServiceDefinition;
}

interface ProtoGrpcType {
  pulseindex: {
    engine: {
      v1: {
        SearchEngineService: SearchEngineServiceClientCtor & {
          service: grpc.ServiceDefinition;
        };
      };
    };
  };
}

const cache = new Map<string, LoadedEngineProto>();

function resolveProtoPath(fileName: string, explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new PulseIndexError(`${fileName} not found at ${explicit}`, {
        code: 'PROTO_NOT_FOUND',
      });
    }
    return explicit;
  }

  const here =
    typeof __dirname === 'string' && __dirname.length > 0
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));

  const candidates = [
    join(here, '..', '..', 'proto', fileName),
    join(here, '..', 'proto', fileName),
    join(here, 'proto', fileName),
    join(process.cwd(), 'proto', fileName),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new PulseIndexError(
    `${fileName} not found. Looked in: ${candidates.join(', ')}`,
    { code: 'PROTO_NOT_FOUND' },
  );
}

export function resolveEngineProtoPath(explicit?: string): string {
  return resolveProtoPath('engine.proto', explicit);
}

export function resolveHealthProtoPath(explicit?: string): string {
  return resolveProtoPath('health.proto', explicit);
}

export function loadEngineProto(protoPath?: string): LoadedEngineProto {
  const resolved = resolveEngineProtoPath(protoPath);
  const cached = cache.get(resolved);
  if (cached) {
    return cached;
  }

  const definition = protoLoader.loadSync(resolved, PROTO_LOADER_OPTIONS);
  const grpcObject = grpc.loadPackageDefinition(definition) as unknown as ProtoGrpcType;
  const serviceCtor = grpcObject.pulseindex?.engine?.v1?.SearchEngineService;

  if (!serviceCtor) {
    throw new PulseIndexError(
      'Failed to load pulseindex.engine.v1.SearchEngineService from engine.proto',
      { code: 'PROTO_LOAD_FAILED' },
    );
  }

  const loaded: LoadedEngineProto = {
    protoPath: resolved,
    SearchEngineService: serviceCtor,
    service: serviceCtor.service,
  };
  cache.set(resolved, loaded);
  return loaded;
}

/** `grpc.health.v1.Health`: the readiness check that needs no scope. */
export interface HealthClient extends grpc.Client {
  check(
    request: { service: string },
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<{ status?: number }>,
  ): grpc.ClientUnaryCall;
}

export type HealthClientCtor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
  options?: object,
) => HealthClient;

/** Values of `grpc.health.v1.HealthCheckResponse.ServingStatus`. */
export const SERVING_STATUS = {
  UNKNOWN: 0,
  SERVING: 1,
  NOT_SERVING: 2,
  SERVICE_UNKNOWN: 3,
} as const;

interface HealthProtoGrpcType {
  grpc: { health: { v1: { Health: HealthClientCtor } } };
}

const healthCache = new Map<string, HealthClientCtor>();

export function loadHealthProto(protoPath?: string): HealthClientCtor {
  const resolved = resolveHealthProtoPath(protoPath);
  const cached = healthCache.get(resolved);
  if (cached) {
    return cached;
  }

  const definition = protoLoader.loadSync(resolved, PROTO_LOADER_OPTIONS);
  const grpcObject = grpc.loadPackageDefinition(definition) as unknown as HealthProtoGrpcType;
  const ctor = grpcObject.grpc?.health?.v1?.Health;

  if (!ctor) {
    throw new PulseIndexError(
      'Failed to load grpc.health.v1.Health from health.proto',
      { code: 'PROTO_LOAD_FAILED' },
    );
  }

  healthCache.set(resolved, ctor);
  return ctor;
}
