import type { SQLiteDatabase } from 'expo-sqlite';

import {
  completeWakeClaim,
  decidePipelineWakeClaim,
  generationNeedingNativeSchedule,
  markNativeScheduleOutcome,
  persistDeferredWakeSignal,
  persistWakeSignal,
  type NativeScheduleState,
  type PipelineWakeNativeTarget,
  type PipelineWakeSnapshot,
} from '@/core/pipeline/pipelineWakeState';
import { getDb, withDurableWakeTransaction } from '@/data/db';
import type { CloudFailureClass } from '@/data/meetings';

export type PipelineWakeReason =
  | 'connectivity_restored'
  | 'transport_deferred'
  | 'foreground'
  | 'native_progress'
  | 'startup_repair';

export type PipelineWakeState = PipelineWakeSnapshot & {
  lastReason: PipelineWakeReason | null;
  lastEnqueuedGeneration: number | null;
  lastEnqueuedWorkId: string | null;
  lastEnqueuedAt: number | null;
  lastEnqueuedScheduleRevision: number | null;
  lastEnqueuedNotBeforeAt: number | null;
  lastErrorCode: string | null;
  updatedAt: number;
};

type PipelineWakeRow = {
  signal_sequence: number;
  requested_generation: number;
  completed_generation: number;
  current_generation: number | null;
  current_retry_not_before_at: number | null;
  pending_generation: number | null;
  pending_not_before_at: number | null;
  enqueue_required: number;
  connectivity_epoch: number;
  last_connected: number | null;
  pending_requires_network: number;
  active_attempt_token: string | null;
  active_attempt_generation: number | null;
  active_attempt_lease_until: number | null;
  last_reason: PipelineWakeReason | null;
  native_schedule_state: NativeScheduleState;
  native_schedule_attempts: number;
  native_schedule_revision: number;
  last_enqueued_generation: number | null;
  last_enqueued_work_id: string | null;
  last_enqueued_at: number | null;
  last_enqueued_schedule_revision: number | null;
  last_enqueued_not_before_at: number | null;
  last_error_code: string | null;
  updated_at: number;
};

const SELECT_WAKE = `SELECT signal_sequence, requested_generation, completed_generation,
  current_generation, current_retry_not_before_at, pending_generation, pending_not_before_at,
  enqueue_required, connectivity_epoch, last_connected, pending_requires_network,
  active_attempt_token, active_attempt_generation, active_attempt_lease_until,
  last_reason, native_schedule_state, native_schedule_attempts, native_schedule_revision,
  last_enqueued_generation, last_enqueued_work_id, last_enqueued_at,
  last_enqueued_schedule_revision, last_enqueued_not_before_at,
  last_error_code, updated_at
  FROM pipeline_wake_state WHERE singleton_id = 1`;

const toState = (row: PipelineWakeRow): PipelineWakeState => ({
  signalSequence: Math.max(0, row.signal_sequence),
  requestedGeneration: Math.max(0, row.requested_generation),
  completedGeneration: Math.max(0, row.completed_generation),
  currentGeneration: row.current_generation,
  currentRetryNotBeforeAt: row.current_retry_not_before_at,
  pendingGeneration: row.pending_generation,
  pendingNotBeforeAt: row.pending_not_before_at,
  enqueueRequired: row.enqueue_required === 1,
  connectivityEpoch: Math.max(0, row.connectivity_epoch),
  lastConnected: row.last_connected == null ? null : row.last_connected === 1,
  requiresNetwork: row.pending_requires_network === 1,
  activeAttemptToken: row.active_attempt_token,
  activeAttemptGeneration: row.active_attempt_generation,
  activeAttemptLeaseUntil: row.active_attempt_lease_until,
  nativeScheduleState: row.native_schedule_state,
  nativeScheduleAttempts: Math.max(0, row.native_schedule_attempts),
  nativeScheduleRevision: Math.max(0, row.native_schedule_revision),
  lastReason: row.last_reason,
  lastEnqueuedGeneration: row.last_enqueued_generation,
  lastEnqueuedWorkId: row.last_enqueued_work_id,
  lastEnqueuedAt: row.last_enqueued_at,
  lastEnqueuedScheduleRevision: row.last_enqueued_schedule_revision,
  lastEnqueuedNotBeforeAt: row.last_enqueued_not_before_at,
  lastErrorCode: row.last_error_code,
  updatedAt: row.updated_at,
});

async function writeWakeDecision(
  transaction: SQLiteDatabase,
  decision: PipelineWakeSnapshot,
  input: { now: number; reason?: PipelineWakeReason; clearError?: boolean },
): Promise<void> {
  await transaction.runAsync(
    `UPDATE pipeline_wake_state SET
      signal_sequence = ?, requested_generation = ?, completed_generation = ?,
      current_generation = ?, current_retry_not_before_at = ?,
      pending_generation = ?, pending_not_before_at = ?, enqueue_required = ?,
      connectivity_epoch = ?, last_connected = ?, pending_requires_network = ?,
      active_attempt_token = ?, active_attempt_generation = ?, active_attempt_lease_until = ?,
      native_schedule_state = ?, native_schedule_attempts = ?, native_schedule_revision = ?,
      last_reason = COALESCE(?, last_reason),
      last_error_code = CASE WHEN ? = 1 THEN NULL ELSE last_error_code END,
      updated_at = ? WHERE singleton_id = 1`,
    [
      decision.signalSequence,
      decision.requestedGeneration,
      decision.completedGeneration,
      decision.currentGeneration,
      decision.currentRetryNotBeforeAt,
      decision.pendingGeneration,
      decision.pendingNotBeforeAt,
      decision.enqueueRequired ? 1 : 0,
      decision.connectivityEpoch,
      decision.lastConnected == null ? null : decision.lastConnected ? 1 : 0,
      decision.requiresNetwork ? 1 : 0,
      decision.activeAttemptToken,
      decision.activeAttemptGeneration,
      decision.activeAttemptLeaseUntil,
      decision.nativeScheduleState,
      decision.nativeScheduleAttempts,
      decision.nativeScheduleRevision,
      input.reason ?? null,
      input.clearError === true ? 1 : 0,
      input.now,
    ],
  );
}

export async function getPipelineWakeState(): Promise<PipelineWakeState> {
  const db = await getDb();
  const row = await db.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
  if (!row) throw new Error('Pipeline wake state is unavailable.');
  return toState(row);
}

export async function persistPipelineWakeSignal(input: {
  reason: PipelineWakeReason;
  connected?: boolean;
  requiresNetwork?: boolean;
}): Promise<PipelineWakeState & { openedGeneration: boolean }> {
  const now = Date.now();
  let openedGeneration = false;
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) throw new Error('Pipeline wake state is unavailable.');
    const decision = persistWakeSignal(toState(row), {
      connected: input.connected,
      requiresNetwork: input.requiresNetwork === true,
    }, now);
    openedGeneration = decision.openedGeneration;
    await writeWakeDecision(transaction, decision, {
      now,
      reason: input.reason,
      clearError: true,
    });
  });
  return { ...await getPipelineWakeState(), openedGeneration };
}

/** Merge a per-item retry row and its future wake owner in the same transaction. */
export async function persistDeferredPipelineWakeInTransaction(
  transaction: SQLiteDatabase,
  input: { notBeforeAt: number; requiresNetwork: boolean; now?: number },
): Promise<PipelineWakeSnapshot> {
  const now = input.now ?? Date.now();
  const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
  if (!row) throw new Error('Pipeline wake state is unavailable.');
  const decision = persistDeferredWakeSignal(toState(row), {
    requiresNetwork: input.requiresNetwork,
    notBeforeAt: input.notBeforeAt,
  }, now);
  await writeWakeDecision(transaction, decision, {
    now,
    reason: 'transport_deferred',
    clearError: true,
  });
  return decision;
}

/** Initial/same-state observations update only connectivity; false->true opens work atomically. */
export async function persistPipelineConnectivity(connected: boolean): Promise<{
  state: PipelineWakeState;
  reconnectGeneration: number | null;
}> {
  const now = Date.now();
  let reconnectGeneration: number | null = null;
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) throw new Error('Pipeline wake state is unavailable.');
    const current = toState(row);
    if (connected && current.lastConnected === false) {
      const decision = persistWakeSignal(current, { connected: true, requiresNetwork: true }, now);
      reconnectGeneration = decision.requestedGeneration;
      await writeWakeDecision(transaction, decision, {
        now,
        reason: 'connectivity_restored',
        clearError: true,
      });
      return;
    }
    await transaction.runAsync(
      'UPDATE pipeline_wake_state SET last_connected = ?, updated_at = ? WHERE singleton_id = 1',
      [connected ? 1 : 0, now],
    );
  });
  return { state: await getPipelineWakeState(), reconnectGeneration };
}

export type PipelineWakeAttempt =
  | { status: 'claimed' | 'reclaimed'; token: string; generation: number; connectivityEpoch: number }
  | { status: 'busy' | 'obsolete' | 'no_work' | 'not_due'; generation: number; notBeforeAt?: number };

export const PIPELINE_WAKE_LEASE_MS = 60_000;
const PIPELINE_WAKE_FAILURE_RETRY_MS = 15_000;

export async function beginPipelineWakeAttempt(expectedGeneration: number): Promise<PipelineWakeAttempt> {
  const now = Date.now();
  const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  let result: PipelineWakeAttempt = { status: 'no_work', generation: expectedGeneration };
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) return;
    const current = toState(row);
    const decision = decidePipelineWakeClaim(current, expectedGeneration, now);
    if (decision.status !== 'claimed' && decision.status !== 'reclaimed') {
      result = {
        status: decision.status,
        generation: decision.generation,
        ...('notBeforeAt' in decision ? { notBeforeAt: decision.notBeforeAt } : {}),
      };
      return;
    }
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET
        current_retry_not_before_at = NULL,
        active_attempt_token = ?, active_attempt_generation = ?,
        active_attempt_lease_until = ?, native_schedule_state = 'claimed',
        last_started_at = ?, updated_at = ? WHERE singleton_id = 1`,
      [token, expectedGeneration, now + PIPELINE_WAKE_LEASE_MS, now, now],
    );
    result = {
      status: decision.status,
      token,
      generation: expectedGeneration,
      connectivityEpoch: current.connectivityEpoch,
    };
  });
  return result;
}

export async function renewPipelineWakeAttempt(token: string): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    `UPDATE pipeline_wake_state SET active_attempt_lease_until = ?, updated_at = ?
     WHERE singleton_id = 1 AND active_attempt_token = ?`,
    [now + PIPELINE_WAKE_LEASE_MS, now, token],
  );
  return result.changes === 1;
}

async function earliestCanonicalPipelineDue(
  transaction: SQLiteDatabase,
  now: number,
): Promise<number | null> {
  const row = await transaction.getFirstAsync<{ due_at: number | null }>(
    `SELECT MIN(due_at) AS due_at FROM (
      SELECT CASE
        WHEN summary_status IN ('queued', 'running')
          THEN MAX(?, COALESCE(cloud_notes_last_polled_at, 0) + 5000)
        ELSE cloud_notes_next_retry_at
      END AS due_at
      FROM meetings
      WHERE summary_status IN ('queued', 'running', 'retryable')
      UNION ALL
      SELECT CASE
        WHEN knowledge_cloud_sync_status IN ('sync_queued', 'syncing') THEN ?
        ELSE knowledge_cloud_next_retry_at
      END AS due_at
      FROM meetings
      WHERE knowledge_cloud_sync_status IN (
        'sync_queued', 'syncing', 'sync_failed_retryable', 'sync_blocked_budget'
      )
      UNION ALL
      SELECT CASE
        WHEN sync_status IN ('sync_queued', 'syncing') THEN ?
        ELSE next_retry_at
      END AS due_at
      FROM knowledge_cloud_corrections
      WHERE sync_status IN ('sync_queued', 'syncing', 'sync_failed_retryable', 'sync_blocked_budget')
    ) WHERE due_at IS NOT NULL`,
    [now, now, now],
  );
  return row?.due_at ?? null;
}

export async function completePipelineWakeAttempt(input: {
  token: string;
  succeeded: boolean;
  errorCode?: string | null;
}): Promise<boolean> {
  const now = Date.now();
  let completed = false;
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row || row.active_attempt_token !== input.token) return;
    const canonicalNextDueAt = input.succeeded
      ? await earliestCanonicalPipelineDue(transaction, now)
      : null;
    const decision = completeWakeClaim(toState(row), {
      tokenMatches: true,
      succeeded: input.succeeded,
      now,
      failureRetryAt: now + PIPELINE_WAKE_FAILURE_RETRY_MS,
      canonicalNextDueAt,
    });
    await writeWakeDecision(transaction, decision, { now });
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET
        last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END,
        last_error_code = ?, updated_at = ? WHERE singleton_id = 1`,
      [input.succeeded ? 1 : 0, now, input.errorCode ?? null, now],
    );
    completed = true;
  });
  return completed;
}

function sameEnqueuedTarget(state: PipelineWakeState, target: PipelineWakeNativeTarget) {
  return state.nativeScheduleState === 'enqueued'
    && state.lastEnqueuedGeneration === target.generation
    && state.lastEnqueuedScheduleRevision === target.scheduleRevision
    && state.lastEnqueuedNotBeforeAt === target.notBeforeAt;
}

/** Target for native scheduling, including a future due time. */
export async function generationAwaitingNativeSchedule(
  now = Date.now(),
): Promise<PipelineWakeNativeTarget | null> {
  const state = await getPipelineWakeState();
  const target = generationNeedingNativeSchedule(state, now);
  if (!target || state.nativeScheduleState === 'max_attempts' || sameEnqueuedTarget(state, target)) return null;
  return target;
}

/** Periodic OS delivery may drain due SQLite work even after native enqueue attempts exhausted. */
export async function generationDueForPeriodicDrain(now = Date.now()): Promise<number | null> {
  const state = await getPipelineWakeState();
  const target = generationNeedingNativeSchedule(state, now);
  return target && target.notBeforeAt <= now ? target.generation : null;
}

export async function recordNativeScheduleOutcome(input: {
  generation: number;
  scheduleRevision: number;
  notBeforeAt: number;
  outcome: 'enqueued' | 'unavailable' | 'failed' | 'max_attempts';
  workId?: string | null;
  errorCode?: string | null;
}): Promise<PipelineWakeState> {
  const now = Date.now();
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) return;
    const current = toState(row);
    const decision = markNativeScheduleOutcome(current, input);
    if (decision === current) return;
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET native_schedule_state = ?, native_schedule_attempts = ?,
        last_enqueued_generation = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_generation END,
        last_enqueued_work_id = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_work_id END,
        last_enqueued_at = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_at END,
        last_enqueued_schedule_revision = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_schedule_revision END,
        last_enqueued_not_before_at = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_not_before_at END,
        last_error_code = ?, updated_at = ? WHERE singleton_id = 1`,
      [
        decision.nativeScheduleState,
        decision.nativeScheduleAttempts,
        input.outcome,
        input.generation,
        input.outcome,
        input.workId ?? null,
        input.outcome,
        now,
        input.outcome,
        input.scheduleRevision,
        input.outcome,
        input.notBeforeAt,
        input.errorCode ?? null,
        now,
      ],
    );
  });
  return getPipelineWakeState();
}

const TRANSPORT_FAILURE_CLASSES: CloudFailureClass[] = [
  'offline', 'dns', 'tls', 'socket', 'timeout', 'transport_unknown',
];

export async function prepareTransportRetriesForConnectivityEpoch(epoch: number): Promise<void> {
  if (epoch <= 0) return;
  const placeholders = TRANSPORT_FAILURE_CLASSES.map(() => '?').join(', ');
  const now = Date.now();
  await withDurableWakeTransaction(async (transaction) => {
    await transaction.runAsync(
      `UPDATE meetings SET cloud_notes_next_retry_at = NULL,
         cloud_notes_last_wake_epoch = ?, updated_at = ?
       WHERE summary_status = 'retryable'
         AND cloud_notes_failure_class IN (${placeholders})
         AND cloud_notes_last_wake_epoch < ?`,
      [epoch, now, ...TRANSPORT_FAILURE_CLASSES, epoch],
    );
    await transaction.runAsync(
      `UPDATE meetings SET knowledge_cloud_next_retry_at = NULL,
         knowledge_cloud_last_wake_epoch = ?, updated_at = ?
       WHERE knowledge_cloud_sync_status = 'sync_failed_retryable'
         AND knowledge_cloud_failure_class IN (${placeholders})
         AND knowledge_cloud_last_wake_epoch < ?`,
      [epoch, now, ...TRANSPORT_FAILURE_CLASSES, epoch],
    );
    await transaction.runAsync(
      `UPDATE knowledge_cloud_corrections SET next_retry_at = NULL,
         last_wake_epoch = ?, updated_at = ?
       WHERE sync_status = 'sync_failed_retryable'
         AND failure_class IN (${placeholders})
         AND last_wake_epoch < ?`,
      [epoch, now, ...TRANSPORT_FAILURE_CLASSES, epoch],
    );
  });
}
