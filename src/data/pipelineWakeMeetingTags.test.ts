/* eslint-disable import/first -- the durable SQLite double must precede the production import. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const idleRow = () => ({
    signal_sequence: 1,
    requested_generation: 1,
    completed_generation: 0,
    current_generation: 1,
    current_retry_not_before_at: 15_000,
    pending_generation: null,
    pending_not_before_at: null,
    enqueue_required: 1,
    connectivity_epoch: 1,
    last_connected: 1,
    pending_requires_network: 1,
    active_attempt_token: 'retry-owner',
    active_attempt_generation: 1,
    active_attempt_lease_until: 75_000,
    last_reason: 'transport_deferred',
    native_schedule_state: 'claimed',
    native_schedule_attempts: 0,
    native_schedule_revision: 1,
    last_enqueued_generation: 1,
    last_enqueued_work_id: 'wake-1',
    last_enqueued_at: 15_000,
    last_enqueued_schedule_revision: 1,
    last_enqueued_not_before_at: 15_000,
    last_error_code: null,
    updated_at: 15_000,
  });
  let wake = idleRow();
  const tagLeaseUntil = 60_000;

  const transaction = {
    getFirstAsync: vi.fn(async (sql: string, _params?: (number | string | null)[]) => {
      if (sql.includes('SELECT MIN(due_at)')) {
        if (!sql.includes('FROM meeting_tag_outbox')) {
          throw new Error('meeting-tag canonical due source is missing');
        }
        return { due_at: tagLeaseUntil };
      }
      return { ...wake };
    }),
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
        ] = values;
        Object.assign(wake, {
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
        });
        return { changes: 1 };
      }
      if (sql.includes('current_retry_not_before_at = NULL')) {
        const [token, generation, leaseUntil, startedAt] = values;
        Object.assign(wake, {
          current_retry_not_before_at: null,
          active_attempt_token: token,
          active_attempt_generation: generation,
          active_attempt_lease_until: leaseUntil,
          native_schedule_state: 'claimed',
          updated_at: startedAt,
        });
        return { changes: 1 };
      }
      if (sql.includes('last_completed_at')) return { changes: 1 };
      throw new Error(`Unexpected pipeline-wake SQL: ${sql}`);
    }),
  };

  return {
    reset: () => { wake = idleRow(); },
    snapshot: () => ({ ...wake }),
    transaction,
  };
});

vi.mock('@/data/db', () => ({
  getDb: vi.fn(async () => fake.transaction),
  withDurableWakeTransaction: vi.fn(async (work: (transaction: typeof fake.transaction) => unknown) => (
    work(fake.transaction)
  )),
}));

import {
  beginPipelineWakeAttempt,
  completePipelineWakeAttempt,
  generationDueForPeriodicDrain,
} from './pipelineWake';

describe('meeting-tag lease truth in the durable wake owner', () => {
  beforeEach(() => {
    fake.reset();
    vi.clearAllMocks();
  });

  it('schedules an owner-independent running tag row and reopens its generation at lease expiry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(15_000);
    await expect(completePipelineWakeAttempt({ token: 'retry-owner', succeeded: true }))
      .resolves.toBe(true);
    expect(fake.snapshot()).toMatchObject({
      completed_generation: 1,
      current_generation: 2,
      current_retry_not_before_at: 60_000,
      enqueue_required: 1,
    });
    expect(await generationDueForPeriodicDrain(59_999)).toBeNull();
    expect(await generationDueForPeriodicDrain(60_000)).toBe(2);

    vi.spyOn(Date, 'now').mockReturnValue(60_000);
    await expect(beginPipelineWakeAttempt(2)).resolves.toMatchObject({
      status: 'claimed',
      generation: 2,
    });
    const canonicalQuery = fake.transaction.getFirstAsync.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('SELECT MIN(due_at)'));
    expect(canonicalQuery).toContain("WHEN state = 'queued' THEN ?");
    expect(canonicalQuery).toContain("WHEN state = 'running' THEN lease_until");
    expect(canonicalQuery).toContain('ELSE next_attempt_at');
    const canonicalCall = fake.transaction.getFirstAsync.mock.calls
      .find(([sql]) => String(sql).includes('SELECT MIN(due_at)'));
    expect(canonicalCall?.[1]).toEqual([15_000, 15_000, 15_000, 15_000]);
  });
});
