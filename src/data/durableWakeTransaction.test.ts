/* eslint-disable import/first -- the Expo SQLite double must exist before importing db.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const expo = vi.hoisted(() => ({
  openDatabaseAsync: vi.fn(),
}));

vi.mock('expo-sqlite', () => expo);

import {
  DURABLE_WAKE_BUSY_TIMEOUT_MS,
  withDurableWakeTransaction,
} from './db';

type ConnectionDouble = {
  execAsync: ReturnType<typeof vi.fn>;
  closeAsync: ReturnType<typeof vi.fn>;
};

function connectionDouble(failOn?: string): ConnectionDouble {
  return {
    execAsync: vi.fn(async (sql: string) => {
      if (sql === failOn) throw new Error(`failed:${sql}`);
    }),
    closeAsync: vi.fn(async () => undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('durable wake write transaction', () => {
  it('configures the actual fresh connection before BEGIN IMMEDIATE and closes after commit', async () => {
    const connection = connectionDouble();
    const task = vi.fn(async () => 'committed');

    await expect(withDurableWakeTransaction(task, {
      openConnection: async () => connection as never,
    })).resolves.toBe('committed');

    expect(connection.execAsync.mock.calls.map(([sql]) => sql)).toEqual([
      `PRAGMA busy_timeout = ${DURABLE_WAKE_BUSY_TIMEOUT_MS};`,
      'PRAGMA foreign_keys = ON;',
      'BEGIN IMMEDIATE;',
      'COMMIT;',
    ]);
    expect(task).toHaveBeenCalledWith(connection);
    expect(connection.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('rolls back and closes when work fails without turning the failure into success', async () => {
    const connection = connectionDouble();
    const failure = new Error('write failed');

    await expect(withDurableWakeTransaction(async () => {
      throw failure;
    }, {
      openConnection: async () => connection as never,
      busyTimeoutMs: 37,
    })).rejects.toBe(failure);

    expect(connection.execAsync.mock.calls.map(([sql]) => sql)).toEqual([
      'PRAGMA busy_timeout = 37;',
      'PRAGMA foreign_keys = ON;',
      'BEGIN IMMEDIATE;',
      'ROLLBACK;',
    ]);
    expect(connection.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('treats finite BEGIN IMMEDIATE exhaustion as deferred work with no task or completion', async () => {
    const connection = connectionDouble('BEGIN IMMEDIATE;');
    const task = vi.fn(async () => undefined);

    await expect(withDurableWakeTransaction(task, {
      openConnection: async () => connection as never,
    })).rejects.toThrow('failed:BEGIN IMMEDIATE;');

    expect(task).not.toHaveBeenCalled();
    expect(connection.execAsync).not.toHaveBeenCalledWith('COMMIT;');
    expect(connection.execAsync).not.toHaveBeenCalledWith('ROLLBACK;');
    expect(connection.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves exhausted work recoverable by a later bounded repair transaction', async () => {
    const exhausted = connectionDouble('BEGIN IMMEDIATE;');
    const repaired = connectionDouble();
    const task = vi.fn(async () => 'recovered');

    await expect(withDurableWakeTransaction(task, {
      openConnection: async () => exhausted as never,
      busyTimeoutMs: 1,
    })).rejects.toThrow('failed:BEGIN IMMEDIATE;');
    expect(task).not.toHaveBeenCalled();

    await expect(withDurableWakeTransaction(task, {
      openConnection: async () => repaired as never,
      busyTimeoutMs: 1,
    })).resolves.toBe('recovered');
    expect(task).toHaveBeenCalledTimes(1);
    expect(repaired.execAsync.mock.calls.map(([sql]) => sql)).toEqual([
      'PRAGMA busy_timeout = 1;',
      'PRAGMA foreign_keys = ON;',
      'BEGIN IMMEDIATE;',
      'COMMIT;',
    ]);
  });

  it('rolls back a failed commit and preserves the commit failure as primary', async () => {
    const connection = connectionDouble('COMMIT;');

    await expect(withDurableWakeTransaction(async () => undefined, {
      openConnection: async () => connection as never,
    })).rejects.toThrow('failed:COMMIT;');

    expect(connection.execAsync).toHaveBeenCalledWith('ROLLBACK;');
    expect(connection.closeAsync).toHaveBeenCalledTimes(1);
  });

  it('acquires BEGIN IMMEDIATE before either contender reads stale wake state', async () => {
    let locked = false;
    let releaseLock: (() => void) | null = null;
    let wakeState = 0;
    let activeReaders = 0;
    let maxActiveReaders = 0;
    const commandOrder: string[] = [];
    const firstRead = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();

    const openConnection = async () => {
      let ownsLock = false;
      return {
        execAsync: vi.fn(async (sql: string) => {
          commandOrder.push(sql);
          if (sql === 'BEGIN IMMEDIATE;') {
            if (locked) await new Promise<void>((resolve) => { releaseLock = resolve; });
            locked = true;
            ownsLock = true;
          }
          if (sql === 'COMMIT;' || sql === 'ROLLBACK;') {
            if (ownsLock) {
              ownsLock = false;
              locked = false;
              const next = releaseLock;
              releaseLock = null;
              next?.();
            }
          }
        }),
        closeAsync: vi.fn(async () => undefined),
      };
    };

    const mutate = (first: boolean) => withDurableWakeTransaction(async () => {
      activeReaders += 1;
      maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
      const observed = wakeState;
      if (first) {
        firstRead.resolve();
        await releaseFirst.promise;
      }
      wakeState = observed + 1;
      activeReaders -= 1;
    }, { openConnection: openConnection as never });

    const first = mutate(true);
    await firstRead.promise;
    const second = mutate(false);
    await Promise.resolve();

    expect(wakeState).toBe(0);
    expect(maxActiveReaders).toBe(1);
    expect(commandOrder.slice(0, 3)).toEqual([
      `PRAGMA busy_timeout = ${DURABLE_WAKE_BUSY_TIMEOUT_MS};`,
      'PRAGMA foreign_keys = ON;',
      'BEGIN IMMEDIATE;',
    ]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(wakeState).toBe(2);
    expect(maxActiveReaders).toBe(1);
  });
});
