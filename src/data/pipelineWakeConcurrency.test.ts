/* eslint-disable import/first -- Vitest hoisted SQLite double must exist before importing the subject. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlite = vi.hoisted(() => {
  type Row = Record<string, number | string | null>;
  let row: Row;
  let transactionTail: Promise<unknown>;
  let contenders = 0;
  let maxContenders = 0;
  let activeTransactions = 0;
  let maxActiveTransactions = 0;

  const reset = () => {
    row = {
      signal_sequence: 0,
      requested_generation: 0,
      completed_generation: 0,
      current_generation: null,
      current_retry_not_before_at: null,
      pending_generation: null,
      pending_not_before_at: null,
      enqueue_required: 0,
      connectivity_epoch: 0,
      last_connected: 0,
      pending_requires_network: 0,
      active_attempt_token: null,
      active_attempt_generation: null,
      active_attempt_lease_until: null,
      last_reason: null,
      native_schedule_state: 'idle',
      native_schedule_attempts: 0,
      native_schedule_revision: 0,
      last_enqueued_generation: null,
      last_enqueued_work_id: null,
      last_enqueued_at: null,
      last_enqueued_schedule_revision: null,
      last_enqueued_not_before_at: null,
      last_error_code: null,
      updated_at: 0,
    };
    transactionTail = Promise.resolve();
    contenders = 0;
    maxContenders = 0;
    activeTransactions = 0;
    maxActiveTransactions = 0;
  };
  reset();

  const transaction = {
    getFirstAsync: vi.fn(async () => ({ ...row })),
    runAsync: vi.fn(async (sql: string, values: (number | string | null)[]) => {
      if (sql.includes('signal_sequence = ?')) {
        const [
          signalSequence,
          requestedGeneration,
          completedGeneration,
          currentGeneration,
          currentRetryNotBeforeAt,
          pendingGeneration,
          pendingNotBeforeAt,
          enqueueRequired,
          connectivityEpoch,
          lastConnected,
          pendingRequiresNetwork,
          activeAttemptToken,
          activeAttemptGeneration,
          activeAttemptLeaseUntil,
          nativeScheduleState,
          nativeScheduleAttempts,
          nativeScheduleRevision,
          lastReason,
          ,
          updatedAt,
        ] = values;
        Object.assign(row, {
          signal_sequence: signalSequence,
          requested_generation: requestedGeneration,
          completed_generation: completedGeneration,
          current_generation: currentGeneration,
          current_retry_not_before_at: currentRetryNotBeforeAt,
          pending_generation: pendingGeneration,
          pending_not_before_at: pendingNotBeforeAt,
          enqueue_required: enqueueRequired,
          connectivity_epoch: connectivityEpoch,
          last_connected: lastConnected,
          pending_requires_network: pendingRequiresNetwork,
          active_attempt_token: activeAttemptToken,
          active_attempt_generation: activeAttemptGeneration,
          active_attempt_lease_until: activeAttemptLeaseUntil,
          native_schedule_state: nativeScheduleState,
          native_schedule_attempts: nativeScheduleAttempts,
          native_schedule_revision: nativeScheduleRevision,
          last_reason: lastReason,
          last_error_code: null,
          updated_at: updatedAt,
        });
      } else if (sql.includes('last_connected = ?')) {
        row.last_connected = values[0];
        row.updated_at = values[1];
      } else {
        throw new Error(`Unexpected SQL in connectivity test: ${sql}`);
      }
      return { changes: 1 };
    }),
  };

  const db = {
    // Kept deliberately separate from the transaction reader: the previous
    // implementation observed connectivity here, outside the serialized
    // mutation. Concurrent callers could therefore both retain a stale false
    // snapshot before either write began.
    getFirstAsync: vi.fn(async () => ({ ...row })),
    withExclusiveTransactionAsync: vi.fn(<T>(work: (value: typeof transaction) => Promise<T>) => {
      contenders += 1;
      maxContenders = Math.max(maxContenders, contenders);
      const result = transactionTail.then(async () => {
        activeTransactions += 1;
        maxActiveTransactions = Math.max(maxActiveTransactions, activeTransactions);
        try {
          return await work(transaction);
        } finally {
          activeTransactions -= 1;
          contenders -= 1;
        }
      });
      transactionTail = result.then(() => undefined, () => undefined);
      return result;
    }),
  };

  return {
    db,
    reset,
    snapshot: () => ({ ...row }),
    contention: () => ({ maxContenders, maxActiveTransactions }),
    transaction,
  };
});

vi.mock('@/data/db', () => ({
  getDb: vi.fn(async () => sqlite.db),
  // Two callers enter concurrently. The fake BEGIN IMMEDIATE lock is acquired
  // only inside this function, so stale reads would be visible if transaction
  // ownership were not held until commit.
  withDurableWakeTransaction: vi.fn(
    <T>(work: (value: typeof sqlite.transaction) => Promise<T>) => (
      sqlite.db.withExclusiveTransactionAsync(work)
    ),
  ),
}));

import { persistPipelineConnectivity } from './pipelineWake';
import { createPipelineWakeCoordinator } from '@/services/pipelineWakeCoordinator';

beforeEach(() => {
  sqlite.reset();
  vi.clearAllMocks();
});

describe('atomic connectivity transition', () => {
  it('lets two contenders arrive but permits only one BEGIN IMMEDIATE owner to read at a time', async () => {
    await Promise.all([
      persistPipelineConnectivity(true),
      persistPipelineConnectivity(true),
    ]);

    expect(sqlite.contention()).toEqual({ maxContenders: 2, maxActiveTransactions: 1 });
    expect(sqlite.snapshot()).toMatchObject({
      signal_sequence: 1,
      requested_generation: 1,
      connectivity_epoch: 1,
      last_connected: 1,
    });
  });

  it('turns concurrent true callbacks into one epoch, generation and effective outbox drain', async () => {
    const repairNativeScheduling = vi.fn(async () => undefined);
    const packetJobs = new Set<string>();
    const sourceKeys = new Set<string>();
    const runGeneration = vi.fn(async () => {
      // These stand in for the idempotent shared packet/source drain. If the
      // transition opens duplicate generations, this callback is observable.
      packetJobs.add('stable-job');
      sourceKeys.add('meeting:maina:stable-source');
      return { disposition: 'completed' as const, recovery: null };
    });
    const coordinator = createPipelineWakeCoordinator({
      requestSignal: vi.fn(async () => ({ generation: 0 })),
      persistConnectivity: persistPipelineConnectivity,
      repairNativeScheduling,
      runGeneration,
    });

    await Promise.all([
      coordinator.connectivityChanged(true),
      coordinator.connectivityChanged(true),
    ]);

    expect(sqlite.snapshot()).toMatchObject({
      signal_sequence: 1,
      requested_generation: 1,
      connectivity_epoch: 1,
      last_connected: 1,
    });
    expect(runGeneration).toHaveBeenCalledTimes(1);
    expect(repairNativeScheduling).toHaveBeenCalledTimes(2);
    expect(packetJobs).toEqual(new Set(['stable-job']));
    expect(sourceKeys).toEqual(new Set(['meeting:maina:stable-source']));
  });
});
