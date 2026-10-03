import { status, type ServiceError } from '@grpc/grpc-js';

export class PulseIndexError extends Error {
  readonly code: string;
  readonly grpcStatusCode?: number;
  readonly grpcDetails?: string;

  constructor(
    message: string,
    options: {
      code?: string;
      grpcStatusCode?: number;
      grpcDetails?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PulseIndexError';
    this.code = options.code ?? 'PULSEINDEX_ERROR';
    this.grpcStatusCode = options.grpcStatusCode;
    this.grpcDetails = options.grpcDetails;
  }

  static fromGrpc(error: ServiceError | Error): PulseIndexError {
    const serviceError = error as ServiceError;
    const grpcStatusCode =
      typeof serviceError.code === 'number' ? serviceError.code : status.UNKNOWN;
    const grpcDetails =
      typeof serviceError.details === 'string' && serviceError.details.length > 0
        ? serviceError.details
        : error.message;
    const message =
      grpcDetails.length > 0
        ? grpcDetails
        : `gRPC call failed with status ${grpcStatusName(grpcStatusCode)} (${grpcStatusCode})`;

    const base = {
      grpcStatusCode,
      grpcDetails,
      cause: error,
    };

    switch (grpcStatusCode) {
      case status.UNAUTHENTICATED:
      case status.PERMISSION_DENIED:
        return new PulseIndexAuthError(message, {
          ...base,
          code: grpcStatusCode === status.PERMISSION_DENIED ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED',
        });
      case status.UNAVAILABLE:
      case status.DEADLINE_EXCEEDED:
      case status.CANCELLED:
      case status.ABORTED:
        return new PulseIndexConnectionError(message, {
          ...base,
          code: grpcStatusName(grpcStatusCode),
        });
      case status.INVALID_ARGUMENT:
      case status.FAILED_PRECONDITION:
      case status.OUT_OF_RANGE:
      case status.NOT_FOUND:
      case status.ALREADY_EXISTS:
      case status.RESOURCE_EXHAUSTED:
        return new PulseIndexQueryError(message, {
          ...base,
          code: grpcStatusName(grpcStatusCode),
        });
      default:
        return new PulseIndexError(message, {
          ...base,
          code: grpcStatusName(grpcStatusCode),
        });
    }
  }
}

export class PulseIndexConnectionError extends PulseIndexError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof PulseIndexError>[1] = {},
  ) {
    super(message, { ...options, code: options.code ?? 'CONNECTION_ERROR' });
    this.name = 'PulseIndexConnectionError';
  }
}

export class PulseIndexAuthError extends PulseIndexError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof PulseIndexError>[1] = {},
  ) {
    super(message, { ...options, code: options.code ?? 'AUTH_ERROR' });
    this.name = 'PulseIndexAuthError';
  }
}

export class PulseIndexQueryError extends PulseIndexError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof PulseIndexError>[1] = {},
  ) {
    super(message, { ...options, code: options.code ?? 'QUERY_ERROR' });
    this.name = 'PulseIndexQueryError';
  }
}

function grpcStatusName(code: number): string {
  const names = Object.entries(status).find(([, value]) => value === code);
  return names?.[0] ?? `STATUS_${code}`;
}
