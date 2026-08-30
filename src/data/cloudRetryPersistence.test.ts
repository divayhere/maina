/* eslint-disable import/first -- transaction doubles must exist before repository import. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: { runAsync: vi.fn() },
  deferredWake: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./db', () => ({
  getDb: vi.fn(),
  withDurableWakeTransaction: mocks.withTransaction,
}));
vi.mock('./pipelineWake', () => ({
  persistDeferredPipelineWakeInTransaction: mocks.deferredWake,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/' }));

import {
  persistKnowledgeCloudCorrectionRetry,
  persistKnowledgeCloudSourceRetry,
  persistMeetingPacketRetry,
} from './meetings';

describe('atomic cloud retry persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.runAsync.mockResolvedValue({ changes: 1 });
    mocks.deferredWake.mockResolvedValue({});
    mocks.withTransaction.mockImplementation(async (task: (transaction: typeof mocks.transaction) => Promise<void>) => {
      await task(mocks.transaction);
    });
  });

  it('writes packet retry truth and its successor wake in one transaction', async () => {
    await persistMeetingPacketRetry({
      meetingId: 'meeting-1',
      meetingStatus: 'summarizing',
      jobId: 'stable-job',
      retryCount: 2,
      lastRetryAt: 1_000,
      nextRetryAt: 61_000,
      failureClass: 'timeout',
      failureOperation: 'poll_job',
      visibleError: 'Waiting for internet. Maina will continue automatically.',
    });

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.deferredWake).toHaveBeenCalledWith(mocks.transaction, {
      notBeforeAt: 61_000,
      requiresNetwork: true,
      now: 1_000,
    });
    expect(mocks.transaction.runAsync.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deferredWake.mock.invocationCallOrder[0]);
  });

  it('uses the same atomic owner for source and correction backoff', async () => {
    await persistKnowledgeCloudSourceRetry({
      meetingId: 'meeting-1',
      syncStatus: 'sync_failed_retryable',
      retryCount: 1,
      lastRetryAt: 2_000,
      nextRetryAt: 17_000,
      failureClass: 'dns',
      visibleError: 'Waiting for internet. Maina will continue automatically.',
    });
    await persistKnowledgeCloudCorrectionRetry({
      correctionKey: 'correction:stable',
      syncStatus: 'sync_blocked_budget',
      retryCount: 1,
      lastRetryAt: 3_000,
      nextRetryAt: 63_000,
      failureClass: 'backend_retryable',
      visibleError: 'Maina Cloud is temporarily busy. Maina will retry automatically.',
    });

    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    expect(mocks.deferredWake).toHaveBeenNthCalledWith(1, mocks.transaction, expect.objectContaining({
      notBeforeAt: 17_000,
    }));
    expect(mocks.deferredWake).toHaveBeenNthCalledWith(2, mocks.transaction, expect.objectContaining({
      notBeforeAt: 63_000,
    }));
  });
});
