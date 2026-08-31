import {
  MainaCloudApiError,
  MainaCloudScopeError,
  mainaCloudRequestJson,
  requireMainaCloudScope,
} from './mainaCloudSession';
import { getMkcMemoryCacheEntry, putMkcMemoryCacheEntry } from './mkc-memory-cache';
import {
  assessMkcMemoryIntegrity,
  classifyMkcMemoryFailure,
  makeMkcMemoryCacheKey,
  type MkcMemoryIntegrityState,
  type MkcMemoryResourceKind,
} from './mkc-memory-core';

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

export type MkcMemoryReadResult<T> = {
  data: T;
  source: 'network' | 'cache';
  fetchedAt: number;
};

export type MkcMemoryContractErrorMapper = (cause: unknown) => MkcMemoryReadError | null;

type CachedReadInput<T> = {
  enabled?: boolean;
  defaultEnabled: boolean;
  disabledMessage: string;
  path: string;
  kind: MkcMemoryResourceKind;
  scope: unknown;
  decode: (body: unknown) => T;
  checksum?: (data: T) => string | null;
  expiresAt?: (data: T) => number | null;
  signal?: AbortSignal;
  mapContractError?: MkcMemoryContractErrorMapper;
};

function requireEnabled(input: Pick<CachedReadInput<unknown>, 'enabled' | 'defaultEnabled' | 'disabledMessage'>): void {
  if (!(input.enabled ?? input.defaultEnabled)) {
    throw new MkcMemoryReadError('invalid', false, input.disabledMessage);
  }
}

export function asMkcMemoryReadError(cause: unknown, mapContractError?: MkcMemoryContractErrorMapper): MkcMemoryReadError {
  if (cause instanceof MkcMemoryReadError) return cause;
  if (cause instanceof MainaCloudScopeError) return new MkcMemoryReadError('auth', false, cause.message);
  const contractFailure = mapContractError?.(cause);
  if (contractFailure) return contractFailure;
  const status = cause instanceof MainaCloudApiError ? cause.status : 0;
  const code = cause instanceof MainaCloudApiError ? cause.code : 'network_error';
  const failure = classifyMkcMemoryFailure({ status, code });
  return new MkcMemoryReadError(failure.kind, failure.retryable, failure.message);
}

export async function readCachedMkcMemory<T>(input: CachedReadInput<T>): Promise<MkcMemoryReadResult<T>> {
  requireEnabled(input);
  assertReadPath(input.path);
  let session;
  try {
    session = await requireMainaCloudScope('recall:read');
  } catch (cause) {
    throw asMkcMemoryReadError(cause, input.mapContractError);
  }
  const cacheKey = makeMkcMemoryCacheKey({
    ownerUserId: session.user.userId,
    kind: input.kind,
    scope: input.scope,
  });
  try {
    const response = await mainaCloudRequestJson(input.path, { method: 'GET', signal: input.signal });
    const data = input.decode(response.data);
    const fetchedAt = Date.now();
    try {
      await putMkcMemoryCacheEntry({
        ownerUserId: session.user.userId,
        cacheKey,
        kind: input.kind,
        payload: data,
        checksum: input.checksum?.(data) ?? null,
        fetchedAt,
        expiresAt: input.expiresAt?.(data) ?? null,
      });
    } catch {
      // This cache is rebuildable. A local cache write failure must not turn a
      // verified network response into a failed memory read.
    }
    return { data, source: 'network', fetchedAt };
  } catch (cause) {
    const failure = asMkcMemoryReadError(cause, input.mapContractError);
    if (failure.kind !== 'offline') throw failure;
    let cached: Awaited<ReturnType<typeof getMkcMemoryCacheEntry>>;
    try {
      cached = await getMkcMemoryCacheEntry(session.user.userId, cacheKey);
    } catch (cacheCause) {
      const cachedFailure = asMkcMemoryReadError(cacheCause, input.mapContractError);
      throw cachedFailure.kind === 'expired'
        ? cachedFailure
        : new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
    if (!cached) throw failure;
    if (cached.expiresAt != null && cached.expiresAt <= Date.now()) {
      throw new MkcMemoryReadError('expired', false, 'This saved memory is no longer available.');
    }
    try {
      return { data: input.decode(cached.payload), source: 'cache', fetchedAt: cached.fetchedAt };
    } catch (cacheCause) {
      const cachedFailure = asMkcMemoryReadError(cacheCause, input.mapContractError);
      throw cachedFailure.kind === 'expired'
        ? cachedFailure
        : new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
  }
}

export async function mutateMkcMemory<T>(input: {
  enabled?: boolean;
  defaultEnabled: boolean;
  disabledMessage: string;
  path: string;
  body?: unknown;
  decode: (body: unknown) => T;
  mapContractError?: MkcMemoryContractErrorMapper;
  signal?: AbortSignal;
}): Promise<T> {
  requireEnabled(input);
  assertReadPath(input.path);
  try {
    await requireMainaCloudScope('recall:read');
    const response = await mainaCloudRequestJson(input.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input.body ?? {}),
      signal: input.signal,
    });
    return input.decode(response.data);
  } catch (cause) {
    throw asMkcMemoryReadError(cause, input.mapContractError);
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
    await requireMainaCloudScope('recall:read');
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
    throw asMkcMemoryReadError(cause);
  }
}
