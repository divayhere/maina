/* eslint-disable import/first -- native and SQLite doubles must exist before db.ts loads. */
import { describe, expect, it, vi } from 'vitest';

const expo = vi.hoisted(() => ({
  openDatabaseAsync: vi.fn(),
}));
const recorder = vi.hoisted(() => ({
  pending: false,
  token: 0,
  MainaRecorder: {
    acquireDatabaseWriterLease: vi.fn(async () => `token-${++recorder.token}`),
    releaseDatabaseWriterLease: vi.fn(() => true),
    isDatabaseRecordingAdmissionPending: vi.fn(() => recorder.pending),
  },
}));

vi.mock('expo-sqlite', () => expo);
vi.mock('../../modules/maina-recorder/src', () => ({ MainaRecorder: recorder.MainaRecorder }));

import { initDb, RecordingAdmissionPriorityError } from './db';

describe('database initialization admission', () => {
  it('rolls back a migration when recording arrives between migration statements', async () => {
    const rootConnection = {
      execAsync: vi.fn(async () => undefined),
      getFirstAsync: vi.fn(async () => ({ user_version: 20 })),
    };
    const migrationConnection = {
      execAsync: vi.fn(async (sql: string) => {
        if (sql.includes('CREATE TABLE meeting_discard_tombstones')) recorder.pending = true;
      }),
      closeAsync: vi.fn(async () => undefined),
    };
    expo.openDatabaseAsync
      .mockResolvedValueOnce(rootConnection)
      .mockResolvedValueOnce(migrationConnection);

    await expect(initDb()).rejects.toThrow(RecordingAdmissionPriorityError);

    expect(migrationConnection.execAsync).toHaveBeenCalledWith('BEGIN IMMEDIATE;');
    expect(migrationConnection.execAsync).toHaveBeenCalledWith('ROLLBACK;');
    expect(migrationConnection.execAsync).not.toHaveBeenCalledWith('PRAGMA user_version = 21;');
    expect(migrationConnection.execAsync).not.toHaveBeenCalledWith('COMMIT;');
    expect(recorder.MainaRecorder.releaseDatabaseWriterLease).toHaveBeenCalledTimes(2);
  });
});
