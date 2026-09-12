/* eslint-disable import/first -- the Expo SQLite double must exist before importing db.ts. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const expo = vi.hoisted(() => ({
  openDatabaseAsync: vi.fn(),
}));
const recorder = vi.hoisted(() => ({
  MainaRecorder: null as null | {
    acquireDatabaseWriterLease(priority: 'recording' | 'background', timeoutMs: number): Promise<string>;
    releaseDatabaseWriterLease(token: string): boolean;
    isDatabaseRecordingAdmissionPending?(): boolean;
  },
}));

vi.mock('expo-sqlite', () => expo);
vi.mock('../../modules/maina-recorder/src', () => recorder);

import {
  assertRecordingAdmissionInactive,
  DURABLE_WAKE_BUSY_TIMEOUT_MS,
  getDb,
  RecordingAdmissionPriorityError,
  withBackgroundDatabaseWriter,
  withDurableWakeTransaction,
  withImmediateWriteTransaction,
  withRecordingAdmissionPriority,
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

beforeEach(() => {
  vi.clearAllMocks();
  recorder.MainaRecorder = null;
});

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
    expect(task).toHaveBeenCalledTimes(1);
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

  it('does not report failure after COMMIT has succeeded merely because the disposable handle cannot close', async () => {
    const connection = connectionDouble();
    connection.closeAsync.mockRejectedValueOnce(new Error('close-failed-after-commit'));

    await expect(withDurableWakeTransaction(async () => 'committed', {
      openConnection: async () => connection as never,
    })).resolves.toBe('committed');

    expect(connection.execAsync).toHaveBeenCalledWith('COMMIT;');
    expect(connection.execAsync).not.toHaveBeenCalledWith('ROLLBACK;');
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

describe('recording admission priority', () => {
  it('makes low-priority recovery yield while admission waits and always releases afterward', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admission = withRecordingAdmissionPriority(async () => {
      entered.resolve();
      await release.promise;
      return 'committed';
    });

    await entered.promise;
    expect(() => assertRecordingAdmissionInactive()).toThrow(RecordingAdmissionPriorityError);
    release.resolve();
    await expect(admission).resolves.toBe('committed');
    expect(() => assertRecordingAdmissionInactive()).not.toThrow();
  });

  it('releases priority after a failed admission', async () => {
    await expect(withRecordingAdmissionPriority(async () => {
      throw new Error('admission-failed');
    })).rejects.toThrow('admission-failed');
    expect(() => assertRecordingAdmissionInactive()).not.toThrow();
  });

  it('observes process-wide native recording demand and fails closed when the bridge cannot classify it', () => {
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => 'unused'),
      releaseDatabaseWriterLease: vi.fn(() => true),
      isDatabaseRecordingAdmissionPending: vi.fn(() => true),
    };
    expect(() => assertRecordingAdmissionInactive()).toThrow(RecordingAdmissionPriorityError);

    recorder.MainaRecorder.isDatabaseRecordingAdmissionPending = vi.fn(() => {
      throw new Error('destroyed-runtime');
    });
    expect(() => assertRecordingAdmissionInactive()).toThrow(RecordingAdmissionPriorityError);
  });

  it('grants a waiting recording before maintenance that queued earlier', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const activeBackground = withBackgroundDatabaseWriter(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const queuedBackground = withBackgroundDatabaseWriter(async () => {
      order.push('background');
    });
    const recording = withRecordingAdmissionPriority(async () => {
      order.push('recording');
    });
    release.resolve();

    await Promise.all([activeBackground, queuedBackground, recording]);
    expect(order).toEqual(['recording', 'background']);
  });

  it('times out a waiting recording before any recording task or database mutation runs', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const activeBackground = withBackgroundDatabaseWriter(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const task = vi.fn(async () => undefined);

    await expect(withRecordingAdmissionPriority(task, 0)).rejects.toThrow(RecordingAdmissionPriorityError);
    expect(task).not.toHaveBeenCalled();
    release.resolve();
    await activeBackground;
  });

  it('hands off from native admission to SQLite ownership before running the transaction body', async () => {
    const events: string[] = [];
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async (priority, timeoutMs) => {
        events.push(`acquire:${priority}:${timeoutMs}`);
        return 'native-token';
      }),
      releaseDatabaseWriterLease: vi.fn((token) => {
        events.push(`release:${token}`);
        return true;
      }),
    };
    const connection = connectionDouble();

    await withImmediateWriteTransaction(async () => {
      events.push('task');
    }, {
      openConnection: async () => connection as never,
      busyTimeoutMs: 37,
      writerPriority: 'recording',
      writerLeaseTimeoutMs: 41,
    });

    expect(events).toEqual(['acquire:recording:41', 'release:native-token', 'task']);
    expect(connection.execAsync.mock.calls.map(([sql]) => sql)).toEqual([
      'PRAGMA busy_timeout = 37;',
      'PRAGMA foreign_keys = ON;',
      'BEGIN IMMEDIATE;',
      'COMMIT;',
    ]);
  });

  it('uses the exact production deadline remainder after the bounded native recording wait', async () => {
    let now = 1_000;
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => {
        now += 8_000;
        return 'native-token';
      }),
      releaseDatabaseWriterLease: vi.fn(() => true),
    };
    const connection = connectionDouble();

    await withImmediateWriteTransaction(async () => undefined, {
      openConnection: async () => connection as never,
      busyTimeoutMs: 15_000,
      writerPriority: 'recording',
      writerLeaseTimeoutMs: 10_000,
      writerDeadlineMs: 15_000,
      now: () => now,
    });

    expect(recorder.MainaRecorder.acquireDatabaseWriterLease).toHaveBeenCalledWith('recording', 10_000);
    expect(connection.execAsync.mock.calls[0][0]).toBe('PRAGMA busy_timeout = 7000;');
  });

  it('makes a native-coordinated background BEGIN fail fast instead of blocking through teardown', async () => {
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => 'background-token'),
      releaseDatabaseWriterLease: vi.fn(() => true),
    };
    const connection = connectionDouble();

    await withImmediateWriteTransaction(async () => {
      expect(recorder.MainaRecorder?.releaseDatabaseWriterLease).toHaveBeenCalledWith('background-token');
    }, {
      openConnection: async () => connection as never,
      busyTimeoutMs: 5_000,
    });

    expect(recorder.MainaRecorder.acquireDatabaseWriterLease).toHaveBeenCalledWith('background', 0);
    expect(connection.execAsync.mock.calls[0][0]).toBe('PRAGMA busy_timeout = 0;');
  });

  it('serializes two native-admitted runtimes through SQLite after each BEGIN handoff', async () => {
    let token = 0;
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => `token-${++token}`),
      releaseDatabaseWriterLease: vi.fn(() => true),
    };
    let sqliteLocked = false;
    const sqliteWaiters: (() => void)[] = [];
    let activeBodies = 0;
    let maxActiveBodies = 0;
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const openConnection = async () => {
      let ownsLock = false;
      return {
        execAsync: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN IMMEDIATE;') {
            if (sqliteLocked) await new Promise<void>((resolve) => sqliteWaiters.push(resolve));
            sqliteLocked = true;
            ownsLock = true;
          }
          if ((sql === 'COMMIT;' || sql === 'ROLLBACK;') && ownsLock) {
            ownsLock = false;
            sqliteLocked = false;
            sqliteWaiters.shift()?.();
          }
        }),
        closeAsync: vi.fn(async () => undefined),
      };
    };
    const first = withImmediateWriteTransaction(async () => {
      activeBodies += 1;
      maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
      firstEntered.resolve();
      await releaseFirst.promise;
      activeBodies -= 1;
    }, { openConnection: openConnection as never });
    await firstEntered.promise;
    const second = withImmediateWriteTransaction(async () => {
      activeBodies += 1;
      maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
      activeBodies -= 1;
    }, {
      openConnection: openConnection as never,
      writerPriority: 'recording',
      writerLeaseTimeoutMs: 10_000,
      writerDeadlineMs: 15_000,
    });
    await vi.waitFor(() => {
      expect(recorder.MainaRecorder?.acquireDatabaseWriterLease).toHaveBeenCalledTimes(2);
    });
    expect(activeBodies).toBe(1);
    expect(recorder.MainaRecorder.releaseDatabaseWriterLease).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    const firstFailure = await first.catch((cause: unknown) => cause);
    await second;
    expect(firstFailure).toBeInstanceOf(RecordingAdmissionPriorityError);
    expect(maxActiveBodies).toBe(1);
    expect(recorder.MainaRecorder.releaseDatabaseWriterLease).toHaveBeenCalledTimes(2);
  });

  it('rolls back background work when recording arrives after the post-BEGIN check', async () => {
    let recordingPending = false;
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => 'background-token'),
      releaseDatabaseWriterLease: vi.fn(() => true),
      isDatabaseRecordingAdmissionPending: vi.fn(() => recordingPending),
    };
    const connection = {
      execAsync: vi.fn(async () => undefined),
      runAsync: vi.fn(async (sql: string) => {
        if (sql === 'FIRST') recordingPending = true;
        return { changes: 1, lastInsertRowId: 1 };
      }),
      closeAsync: vi.fn(async () => undefined),
    };

    await expect(withImmediateWriteTransaction(async (transaction) => {
      await transaction.runAsync('FIRST');
      await transaction.runAsync('SECOND');
    }, {
      openConnection: async () => connection as never,
    })).rejects.toThrow(RecordingAdmissionPriorityError);

    expect(connection.runAsync).toHaveBeenCalledTimes(1);
    expect(connection.runAsync).toHaveBeenCalledWith('FIRST');
    expect(connection.execAsync).toHaveBeenCalledWith('ROLLBACK;');
    expect(connection.execAsync).not.toHaveBeenCalledWith('COMMIT;');
  });

  it('checks recording demand again before committing a completed background body', async () => {
    let recordingPending = false;
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => 'background-token'),
      releaseDatabaseWriterLease: vi.fn(() => true),
      isDatabaseRecordingAdmissionPending: vi.fn(() => recordingPending),
    };
    const connection = connectionDouble();

    await expect(withImmediateWriteTransaction(async () => {
      recordingPending = true;
    }, {
      openConnection: async () => connection as never,
    })).rejects.toThrow(RecordingAdmissionPriorityError);

    expect(connection.execAsync).toHaveBeenCalledWith('ROLLBACK;');
    expect(connection.execAsync).not.toHaveBeenCalledWith('COMMIT;');
  });

  it('does not invert a completed transaction when native lease teardown throws', async () => {
    recorder.MainaRecorder = {
      acquireDatabaseWriterLease: vi.fn(async () => 'native-token'),
      releaseDatabaseWriterLease: vi.fn(() => {
        throw new Error('module-destroyed-after-commit');
      }),
    };
    const connection = connectionDouble();

    await expect(withImmediateWriteTransaction(async () => 'committed', {
      openConnection: async () => connection as never,
      writerPriority: 'recording',
      writerLeaseTimeoutMs: 41,
    })).resolves.toBe('committed');

    expect(connection.execAsync).toHaveBeenCalledWith('COMMIT;');
    expect(connection.execAsync).not.toHaveBeenCalledWith('ROLLBACK;');
    expect(recorder.MainaRecorder.releaseDatabaseWriterLease).toHaveBeenCalledWith('native-token');
  });

  it('makes direct cached-connection writes join the same background lane', async () => {
    const raw = {
      runAsync: vi.fn(async () => ({ changes: 1, lastInsertRowId: 1 })),
    };
    expo.openDatabaseAsync.mockResolvedValueOnce(raw);
    const db = await getDb();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recording = withRecordingAdmissionPriority(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const write = db.runAsync('UPDATE meetings SET updated_at = updated_at');
    await Promise.resolve();
    expect(raw.runAsync).not.toHaveBeenCalled();
    release.resolve();
    await recording;
    await write;
    expect(raw.runAsync).toHaveBeenCalledTimes(1);
  });
});
