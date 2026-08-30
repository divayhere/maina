import {
  completeWakeClaim,
  decidePipelineWakeClaim,
  generationNeedingNativeSchedule,
  markNativeScheduleOutcome,
  persistWakeSignal,
  type NativeScheduleState,
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
  lastErrorCode: string | null;
  updatedAt: number;
};

type PipelineWakeRow = {
  signal_sequence: number;
  requested_generation: number;
  completed_generation: number;
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
  last_enqueued_generation: number | null;
  last_enqueued_work_id: string | null;
  last_enqueued_at: number | null;
  last_error_code: string | null;
  updated_at: number;
};

const SELECT_WAKE = `SELECT signal_sequence, requested_generation, completed_generation,
  enqueue_required, connectivity_epoch, last_connected, pending_requires_network,
  active_attempt_token, active_attempt_generation, active_attempt_lease_until,
  last_reason, native_schedule_state, native_schedule_attempts,
  last_enqueued_generation, last_enqueued_work_id, last_enqueued_at, last_error_code, updated_at
  FROM pipeline_wake_state WHERE singleton_id = 1`;

const toState = (row: PipelineWakeRow): PipelineWakeState => ({
  signalSequence: Math.max(0, row.signal_sequence),
  requestedGeneration: Math.max(0, row.requested_generation),
  completedGeneration: Math.max(0, row.completed_generation),
  enqueueRequired: row.enqueue_required === 1,
  connectivityEpoch: Math.max(0, row.connectivity_epoch),
  lastConnected: row.last_connected == null ? null : row.last_connected === 1,
  requiresNetwork: row.pending_requires_network === 1,
  activeAttemptToken: row.active_attempt_token,
  activeAttemptGeneration: row.active_attempt_generation,
  activeAttemptLeaseUntil: row.active_attempt_lease_until,
  nativeScheduleState: row.native_schedule_state,
  nativeScheduleAttempts: Math.max(0, row.native_schedule_attempts),
  lastReason: row.last_reason,
  lastEnqueuedGeneration: row.last_enqueued_generation,
  lastEnqueuedWorkId: row.last_enqueued_work_id,
  lastEnqueuedAt: row.last_enqueued_at,
  lastErrorCode: row.last_error_code,
  updatedAt: row.updated_at,
});

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
    });
    openedGeneration = decision.openedGeneration;
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET
        signal_sequence = ?, requested_generation = ?, enqueue_required = ?,
        connectivity_epoch = ?, last_connected = ?, pending_requires_network = ?,
        native_schedule_state = ?, native_schedule_attempts = ?, last_reason = ?,
        last_error_code = NULL, updated_at = ? WHERE singleton_id = 1`,
      [
        decision.signalSequence,
        decision.requestedGeneration,
        decision.enqueueRequired ? 1 : 0,
        decision.connectivityEpoch,
        decision.lastConnected == null ? null : decision.lastConnected ? 1 : 0,
        decision.requiresNetwork ? 1 : 0,
        decision.nativeScheduleState,
        decision.nativeScheduleAttempts,
        input.reason,
        now,
      ],
    );
  });
  return { ...await getPipelineWakeState(), openedGeneration };
}

/**
 * Persist connectivity before process-local coalescing. Only a false->true
 * transition creates work; initial/same-state observations merely repair the
 * durable connectivity snapshot.
 */
export async function persistPipelineConnectivity(connected: boolean): Promise<{
  state: PipelineWakeState;
  reconnectGeneration: number | null;
}> {
  const now = Date.now();
  let result: { state: PipelineWakeState; reconnectGeneration: number | null } | null = null;
  // Observation and mutation must share one BEGIN IMMEDIATE transaction. Two
  // concurrent `true` callbacks may both have been dispatched from NetInfo,
  // but only the first transaction may observe the durable false->true edge.
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) throw new Error('Pipeline wake state is unavailable.');
    const current = toState(row);
    if (connected && current.lastConnected === false) {
      const decision = persistWakeSignal(current, { connected: true, requiresNetwork: true });
      await transaction.runAsync(
        `UPDATE pipeline_wake_state SET
          signal_sequence = ?, requested_generation = ?, enqueue_required = ?,
          connectivity_epoch = ?, last_connected = 1, pending_requires_network = ?,
          native_schedule_state = ?, native_schedule_attempts = ?,
          last_reason = 'connectivity_restored', last_error_code = NULL,
          updated_at = ? WHERE singleton_id = 1`,
        [
          decision.signalSequence,
          decision.requestedGeneration,
          decision.enqueueRequired ? 1 : 0,
          decision.connectivityEpoch,
          decision.requiresNetwork ? 1 : 0,
          decision.nativeScheduleState,
          decision.nativeScheduleAttempts,
          now,
        ],
      );
      result = {
        state: {
          ...current,
          ...decision,
          lastReason: 'connectivity_restored',
          lastErrorCode: null,
          updatedAt: now,
        },
        reconnectGeneration: decision.requestedGeneration,
      };
      return;
    }
    await transaction.runAsync(
      'UPDATE pipeline_wake_state SET last_connected = ?, updated_at = ? WHERE singleton_id = 1',
      [connected ? 1 : 0, now],
    );
    result = {
      state: { ...current, lastConnected: connected, updatedAt: now },
      reconnectGeneration: null,
    };
  });
  if (!result) throw new Error('Pipeline connectivity state was not persisted.');
  return result;
}

export type PipelineWakeAttempt =
  | { status: 'claimed' | 'reclaimed'; token: string; generation: number; connectivityEpoch: number }
  | { status: 'busy' | 'obsolete' | 'no_work'; generation: number };

export const PIPELINE_WAKE_LEASE_MS = 60_000;

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
      result = { status: decision.status, generation: decision.generation };
      return;
    }
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET
        enqueue_required = CASE WHEN requested_generation > ? THEN 1 ELSE 0 END,
        active_attempt_token = ?, active_attempt_generation = ?,
        active_attempt_lease_until = ?, native_schedule_state = 'claimed',
        last_started_at = ?, updated_at = ? WHERE singleton_id = 1`,
      [expectedGeneration, token, expectedGeneration, now + PIPELINE_WAKE_LEASE_MS, now, now],
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
    const decision = completeWakeClaim(toState(row), { tokenMatches: true, succeeded: input.succeeded });
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET
        completed_generation = ?, enqueue_required = ?, pending_requires_network = ?,
        active_attempt_token = NULL, active_attempt_generation = NULL,
        active_attempt_lease_until = NULL, native_schedule_state = ?,
        native_schedule_attempts = ?,
        last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END,
        last_error_code = ?, updated_at = ? WHERE singleton_id = 1`,
      [
        decision.completedGeneration,
        decision.enqueueRequired ? 1 : 0,
        decision.requiresNetwork ? 1 : 0,
        decision.nativeScheduleState,
        decision.nativeScheduleAttempts,
        input.succeeded ? 1 : 0,
        now,
        input.errorCode ?? null,
        now,
      ],
    );
    completed = true;
  });
  return completed;
}

export async function generationAwaitingNativeSchedule(now = Date.now()): Promise<number | null> {
  const state = await getPipelineWakeState();
  const generation = generationNeedingNativeSchedule(state, now);
  if (generation == null || state.nativeScheduleState === 'max_attempts') return null;
  if (state.nativeScheduleState === 'enqueued'
    && state.lastEnqueuedGeneration === generation
    && state.lastEnqueuedAt != null
    && now - state.lastEnqueuedAt < 15 * 60_000
  ) return null;
  return generation;
}

export async function recordNativeScheduleOutcome(input: {
  generation: number;
  outcome: 'enqueued' | 'unavailable' | 'failed' | 'max_attempts';
  workId?: string | null;
  errorCode?: string | null;
}): Promise<PipelineWakeState> {
  const now = Date.now();
  await withDurableWakeTransaction(async (transaction) => {
    const row = await transaction.getFirstAsync<PipelineWakeRow>(SELECT_WAKE);
    if (!row) return;
    const decision = markNativeScheduleOutcome(toState(row), input);
    await transaction.runAsync(
      `UPDATE pipeline_wake_state SET native_schedule_state = ?, native_schedule_attempts = ?,
        last_enqueued_generation = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_generation END,
        last_enqueued_work_id = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_work_id END,
        last_enqueued_at = CASE WHEN ? = 'enqueued' THEN ? ELSE last_enqueued_at END,
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
  });
}
