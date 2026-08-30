import { MainaCloudApiError, mainaCloudRequestJson } from './mainaCloudSession';
import { assessMkcMemoryIntegrity, classifyMkcMemoryFailure, type MkcMemoryIntegrityState } from './mkc-memory-core';

export type DecodedMkcMemory<T> = {
  data: T;
  integrity: Parameters<typeof assessMkcMemoryIntegrity>[0];
};

export class MkcMemoryReadError extends Error {
  constructor(
    readonly kind: ReturnType<typeof classifyMkcMemoryFailure>['kind'],
    readonly retryable: boolean,
    message: string,
    readonly integrity?: MkcMemoryIntegrityState,
  ) {
    super(message);
    this.name = 'MkcMemoryReadError';
  }
}

function assertReadPath(path: string): void {
  if (!path.startsWith('/v1/') || path.includes('://') || /(?:access_token|token)=/i.test(path)) {
    throw new MkcMemoryReadError('invalid', false, 'This memory request is not valid.');
  }
}

export async function readMkcMemory<T>(input: {
  path: string;
  decode: (body: unknown) => DecodedMkcMemory<T>;
  signal?: AbortSignal;
}): Promise<T> {
  assertReadPath(input.path);
  try {
    const response = await mainaCloudRequestJson(input.path, { method: 'GET', signal: input.signal });
    const decoded = input.decode(response.data);
    const integrity = assessMkcMemoryIntegrity(decoded.integrity);
    if (integrity.state !== 'verified') {
      throw new MkcMemoryReadError(
        integrity.state === 'expired' ? 'expired' : integrity.state === 'owner-mismatch' ? 'owner' : 'integrity',
        false,
        integrity.state === 'expired'
          ? 'This saved memory is no longer available.'
          : integrity.state === 'owner-mismatch'
            ? 'This memory is not available to this account.'
            : 'Maina could not verify this memory safely.',
        integrity,
      );
    }
    return decoded.data;
  } catch (cause) {
    if (cause instanceof MkcMemoryReadError) throw cause;
    const status = cause instanceof MainaCloudApiError ? cause.status : 0;
    const code = cause instanceof MainaCloudApiError ? cause.code : 'network_error';
    const failure = classifyMkcMemoryFailure({ status, code });
    throw new MkcMemoryReadError(failure.kind, failure.retryable, failure.message);
  }
}
