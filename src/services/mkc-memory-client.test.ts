/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mainaCloudRequestJson: vi.fn() }));

vi.mock('./mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  },
  MainaCloudScopeError: class MainaCloudScopeError extends Error {},
  requireMainaCloudScope: vi.fn(),
  mainaCloudRequestJson: mocks.mainaCloudRequestJson,
}));
vi.mock('./mkc-memory-cache', () => ({
  getMkcMemoryCacheEntry: vi.fn(),
  putMkcMemoryCacheEntry: vi.fn(),
}));

import { MkcMemoryReadError, readMkcMemory } from './mkc-memory-client';

describe('MKC Memory read adapter', () => {
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
});
