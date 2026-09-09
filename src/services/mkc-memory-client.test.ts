/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mainaCloudRequestJson: vi.fn(),
  requireMainaCloudScope: vi.fn(),
  pinMainaCloudExecutionContext: vi.fn(),
  assertMainaCloudExecutionContext: vi.fn(),
  getMkcMemoryCacheEntry: vi.fn(),
  putMkcMemoryCacheEntry: vi.fn(),
}));

vi.mock('./mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  },
  MainaCloudScopeError: class MainaCloudScopeError extends Error {},
  MainaCloudSessionMismatchError: class MainaCloudSessionMismatchError extends Error {},
  assertMainaCloudExecutionContext: mocks.assertMainaCloudExecutionContext,
  requireMainaCloudScope: mocks.requireMainaCloudScope,
  pinMainaCloudExecutionContext: mocks.pinMainaCloudExecutionContext,
  mainaCloudRequestJson: mocks.mainaCloudRequestJson,
}));
vi.mock('./mkc-memory-cache', () => ({
  getMkcMemoryCacheEntry: mocks.getMkcMemoryCacheEntry,
  putMkcMemoryCacheEntry: mocks.putMkcMemoryCacheEntry,
}));

import {
  MkcMemoryReadError,
  mutateMkcMemory,
  readCachedMkcMemory,
  readMkcMemory,
} from './mkc-memory-client';

const session = {
  accessToken: 'credential-a',
  scopes: ['recall:read'],
  scopesVerifiedAt: 1,
  user: { userId: 'owner-a', email: 'owner-a@maina.local' },
};
const executionContext = {
  ownerUserId: 'owner-a',
  accessToken: 'credential-a',
  scopesVerifiedAt: 1,
};

describe('MKC Memory read adapter', () => {
  beforeEach(() => {
    mocks.mainaCloudRequestJson.mockReset();
    mocks.requireMainaCloudScope.mockReset().mockResolvedValue(session);
    mocks.pinMainaCloudExecutionContext.mockReset().mockReturnValue(executionContext);
    mocks.assertMainaCloudExecutionContext.mockReset().mockResolvedValue(undefined);
    mocks.getMkcMemoryCacheEntry.mockReset();
    mocks.putMkcMemoryCacheEntry.mockReset();
  });

  it('uses a caller-supplied decoder and returns verified data', async () => {
    mocks.mainaCloudRequestJson.mockResolvedValue({ status: 200, ok: true, data: { opaque: true } });
    await expect(readMkcMemory({
      path: '/v1/future-versioned-resource',
      decode: () => ({
        data: { title: 'decoded by generated schema' },
        integrity: {
          expectedOwnerUserId: 'owner-a', receivedOwnerUserId: 'owner-a',
          checksums: [{ field: 'result', expected: 'sha256:a', received: 'sha256:a' }],
        },
      }),
    })).resolves.toEqual({ title: 'decoded by generated schema' });
    expect(mocks.mainaCloudRequestJson).toHaveBeenCalledWith(
      '/v1/future-versioned-resource',
      expect.objectContaining({ method: 'GET' }),
      { executionContext },
    );
  });

  it('blocks mismatched integrity and token-bearing or absolute paths', async () => {
    mocks.mainaCloudRequestJson.mockResolvedValue({ status: 200, ok: true, data: {} });
    await expect(readMkcMemory({
      path: '/v1/future-versioned-resource',
      decode: () => ({
        data: {},
        integrity: {
          expectedOwnerUserId: 'owner-a', receivedOwnerUserId: 'owner-a',
          checksums: [{ field: 'result', expected: 'sha256:a', received: 'sha256:b' }],
        },
      }),
    })).rejects.toEqual(expect.objectContaining({ kind: 'integrity', retryable: false } satisfies Partial<MkcMemoryReadError>));
    await expect(readMkcMemory({ path: 'https://example.test/v1/memory', decode: vi.fn() }))
      .rejects.toEqual(expect.objectContaining({ kind: 'invalid' }));
    await expect(readMkcMemory({ path: '/v1/memory?access_token=secret', decode: vi.fn() }))
      .rejects.toEqual(expect.objectContaining({ kind: 'invalid' }));
  });

  it('pins every Memory transport to the verified owner session', async () => {
    mocks.mainaCloudRequestJson.mockResolvedValue({ status: 200, ok: true, data: { value: 1 } });

    await readCachedMkcMemory({
      enabled: true,
      defaultEnabled: false,
      disabledMessage: 'disabled',
      path: '/v1/memory-pulse',
      kind: 'pulse',
      scope: { window: 'today' },
      decode: (body) => body as { value: number },
    });
    await mutateMkcMemory({
      enabled: true,
      defaultEnabled: false,
      disabledMessage: 'disabled',
      path: '/v1/recall/frozen',
      body: { query: 'bounded' },
      decode: (body) => body as { value: number },
    });

    expect(mocks.pinMainaCloudExecutionContext).toHaveBeenCalledTimes(2);
    expect(mocks.mainaCloudRequestJson).toHaveBeenNthCalledWith(
      1,
      '/v1/memory-pulse',
      expect.objectContaining({ method: 'GET' }),
      { executionContext },
    );
    expect(mocks.mainaCloudRequestJson).toHaveBeenNthCalledWith(
      2,
      '/v1/recall/frozen',
      expect.objectContaining({ method: 'POST' }),
      { executionContext },
    );
  });

  it('rejects an in-flight owner switch without reading or writing another owner cache', async () => {
    const SessionMismatch = (await import('./mainaCloudSession')).MainaCloudSessionMismatchError;
    mocks.mainaCloudRequestJson.mockRejectedValue(new SessionMismatch());

    await expect(readCachedMkcMemory({
      enabled: true,
      defaultEnabled: false,
      disabledMessage: 'disabled',
      path: '/v1/memory-pulse',
      kind: 'pulse',
      scope: { window: 'today' },
      decode: (body) => body,
    })).rejects.toMatchObject({ kind: 'session_changed', retryable: true });

    expect(mocks.getMkcMemoryCacheEntry).not.toHaveBeenCalled();
    expect(mocks.putMkcMemoryCacheEntry).not.toHaveBeenCalled();
  });

  it('rechecks the owner after a deferred cache write before returning network data', async () => {
    const SessionMismatch = (await import('./mainaCloudSession')).MainaCloudSessionMismatchError;
    mocks.mainaCloudRequestJson.mockResolvedValue({ status: 200, ok: true, data: { value: 1 } });
    let finishCacheWrite!: () => void;
    const cacheWrite = new Promise<void>((resolve) => { finishCacheWrite = resolve; });
    mocks.putMkcMemoryCacheEntry.mockReturnValue(cacheWrite);

    const read = readCachedMkcMemory({
      enabled: true,
      defaultEnabled: false,
      disabledMessage: 'disabled',
      path: '/v1/memory-pulse',
      kind: 'pulse',
      scope: { window: 'today' },
      decode: (body) => body,
    });
    await vi.waitFor(() => expect(mocks.putMkcMemoryCacheEntry).toHaveBeenCalledTimes(1));
    mocks.assertMainaCloudExecutionContext.mockRejectedValueOnce(new SessionMismatch());
    finishCacheWrite();

    await expect(read).rejects.toMatchObject({ kind: 'session_changed', retryable: true });
  });

  it('rechecks the owner after a deferred offline cache read before returning cached data', async () => {
    const CloudError = (await import('./mainaCloudSession')).MainaCloudApiError;
    const SessionMismatch = (await import('./mainaCloudSession')).MainaCloudSessionMismatchError;
    mocks.mainaCloudRequestJson.mockRejectedValue(new CloudError('offline', 0, 'network_error'));
    let finishCacheRead!: (value: unknown) => void;
    const cacheRead = new Promise((resolve) => { finishCacheRead = resolve; });
    mocks.getMkcMemoryCacheEntry.mockReturnValue(cacheRead);

    const read = readCachedMkcMemory({
      enabled: true,
      defaultEnabled: false,
      disabledMessage: 'disabled',
      path: '/v1/memory-pulse',
      kind: 'pulse',
      scope: { window: 'today' },
      decode: (body) => body,
    });
    await vi.waitFor(() => expect(mocks.getMkcMemoryCacheEntry).toHaveBeenCalledTimes(1));
    mocks.assertMainaCloudExecutionContext.mockRejectedValueOnce(new SessionMismatch());
    finishCacheRead({ payload: { value: 1 }, fetchedAt: 1, expiresAt: null });

    await expect(read).rejects.toMatchObject({ kind: 'session_changed', retryable: true });
  });
});
