/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAsync: vi.fn(async () => ({ changes: 1, lastInsertRowId: 0 })),
  getFirstAsync: vi.fn(),
}));

vi.mock('@/data/db', () => ({
  getDb: vi.fn(async () => ({ runAsync: mocks.runAsync, getFirstAsync: mocks.getFirstAsync })),
}));

import { clearMkcMemoryCacheForOwner, getMkcMemoryCacheEntry, MkcMemoryCacheError } from './mkc-memory-cache';

describe('MKC Memory cache', () => {
  beforeEach(() => {
    mocks.runAsync.mockClear();
    mocks.getFirstAsync.mockReset();
  });

  it('queries and clears only the requested owner partition', async () => {
    mocks.getFirstAsync.mockResolvedValue(null);
    await expect(getMkcMemoryCacheEntry('owner-a', 'cache-a')).resolves.toBeNull();
    expect(mocks.getFirstAsync).toHaveBeenCalledWith(expect.stringContaining('owner_user_id = ?'), 'owner-a', 'cache-a');

    await clearMkcMemoryCacheForOwner('owner-a');
    expect(mocks.runAsync).toHaveBeenCalledWith(
      'DELETE FROM mkc_memory_cache WHERE owner_user_id = ?;',
      'owner-a',
    );
  });

  it('fails closed instead of returning a corrupt cache payload', async () => {
    mocks.getFirstAsync.mockResolvedValue({
      owner_user_id: 'owner-a', cache_key: 'cache-a', resource_kind: 'meeting-list',
      payload_json: '{not-json', etag: null, checksum: null, fetched_at: 1, expires_at: null,
    });
    await expect(getMkcMemoryCacheEntry('owner-a', 'cache-a')).rejects.toEqual(
      expect.objectContaining({ name: 'MkcMemoryCacheError', code: 'corrupt_cache' } satisfies Partial<MkcMemoryCacheError>),
    );
  });
});
