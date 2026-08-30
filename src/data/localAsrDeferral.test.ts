/* eslint-disable import/first -- Vitest hoists the SQLite double before the subject import. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlite = vi.hoisted(() => ({
  runAsync: vi.fn(async () => ({ changes: 1 })),
}));

vi.mock('@/data/db', () => ({ getDb: vi.fn(async () => sqlite) }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/' }));

import { deferLocalAsrRunGeneration } from './meetings';

beforeEach(() => vi.clearAllMocks());

describe('local ASR native-expiration fence', () => {
  it('defers only the exact still-claimed meeting generation', async () => {
    await expect(deferLocalAsrRunGeneration('meeting-a', 7)).resolves.toBe(true);
    expect(sqlite.runAsync).toHaveBeenCalledTimes(1);
    const [sql, values] = sqlite.runAsync.mock.calls[0];
    expect(sql).toContain("generation = ? AND state = 'claimed'");
    expect(values.slice(2)).toEqual(['meeting-a', 7]);
  });

  it('is an idempotent no-op after another owner has already fenced the run', async () => {
    sqlite.runAsync.mockResolvedValueOnce({ changes: 0 });
    await expect(deferLocalAsrRunGeneration('meeting-a', 7)).resolves.toBe(false);
  });
});
