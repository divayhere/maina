/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mainaCloudFetch: vi.fn() }));

vi.mock('./mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  },
  mainaCloudFetch: mocks.mainaCloudFetch,
}));

import { MkcMemoryReadError, readMkcMemory } from './mkc-memory-client';

describe('MKC Memory read adapter', () => {
  it('uses a caller-supplied decoder and returns verified data', async () => {
    mocks.mainaCloudFetch.mockResolvedValue(new Response(JSON.stringify({ opaque: true }), { status: 200 }));
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
    mocks.mainaCloudFetch.mockResolvedValue(new Response('{}', { status: 200 }));
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
