/* eslint-disable import/first -- database doubles must exist before importing the repository. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDurableWakeTransaction: vi.fn(),
  withImmediateWriteTransaction: vi.fn(),
}));

vi.mock('./db', () => database);
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
}));

import {
  CAPTURE_START_BUSY_TIMEOUT_MS,
  CAPTURE_START_DATABASE_DEADLINE_MS,
  CAPTURE_START_WRITER_LEASE_TIMEOUT_MS,
  createMeeting,
} from './meetings';

function transactionDouble(options: { failStage?: boolean } = {}) {
  let calls = 0;
  return {
    getFirstAsync: vi.fn(async () => null),
    runAsync: vi.fn(async () => {
      calls += 1;
      if (options.failStage && calls === 2) throw new Error('stage-write-failed');
      return { changes: 1, lastInsertRowId: calls };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  database.getDb.mockRejectedValue(new Error('shared connection must not be used'));
});

describe('recording meeting admission', () => {
  it('writes the meeting and initial pipeline stage on one immediate transaction', async () => {
    const transaction = transactionDouble();
    database.withImmediateWriteTransaction.mockImplementation(async (task) => task(transaction));

    await createMeeting({
      id: 'meeting-1',
      title: 'Meeting',
      startedAt: 100,
      durationMs: 0,
      audioUri: 'file:///documents/recordings/meeting-1',
      status: 'recording',
      qualificationEvidenceDigest: 'a'.repeat(64),
    });

    expect(database.withImmediateWriteTransaction).toHaveBeenCalledTimes(1);
    expect(database.withImmediateWriteTransaction.mock.calls[0][1]).toEqual({
      busyTimeoutMs: CAPTURE_START_BUSY_TIMEOUT_MS,
      writerPriority: 'recording',
      writerLeaseTimeoutMs: CAPTURE_START_WRITER_LEASE_TIMEOUT_MS,
      writerDeadlineMs: CAPTURE_START_DATABASE_DEADLINE_MS,
    });
    expect(transaction.runAsync).toHaveBeenCalledTimes(2);
    expect((transaction.runAsync.mock.calls as unknown[][])[0][0]).toContain('INSERT INTO meetings');
    expect(transaction.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining('meeting_pipeline_stages'),
      ['meeting-1', 'recording'],
    );
    expect((transaction.runAsync.mock.calls as unknown[][])[1][0]).toContain('INSERT INTO meeting_pipeline_stages');
    expect(database.getDb).not.toHaveBeenCalled();
  });

  it('propagates a stage failure through the same transaction instead of reporting creation', async () => {
    const transaction = transactionDouble({ failStage: true });
    database.withImmediateWriteTransaction.mockImplementation(async (task) => task(transaction));

    await expect(createMeeting({
      id: 'meeting-2',
      title: 'Meeting',
      startedAt: 200,
      durationMs: 0,
      status: 'recording',
    })).rejects.toThrow('stage-write-failed');

    expect(database.withImmediateWriteTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.runAsync).toHaveBeenCalledTimes(2);
    expect(database.getDb).not.toHaveBeenCalled();
  });
});
