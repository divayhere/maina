import { getDb } from '@/data/db';
import type { CloudFailureClass } from '@/data/meetings';
import {
  decidePipelineWakeClaim,
  requestWakeGeneration,
  type PipelineWakeClaimDecision,
  type PipelineWakeSnapshot,
} from '@/core/pipeline/pipelineWakeState';

export type PipelineWakeReason =
  | 'connectivity_restored'
  | 'transport_deferred'
  | 'foreground'
  | 'native_progress'
  | 'os_worker'
  | 'startup_repair';

export type PipelineWakeState = {
  generation: number;
  enqueueRequired: boolean;
  connectivityEpoch: number;
  activeAttemptToken: string | null;
  activeAttemptGeneration: number | null;
  activeAttemptLeaseUntil: number | null;
  lastReason: PipelineWakeReason | null;
  lastRequestKey: string | null;
  lastEnqueuedGeneration: number | null;
  attemptCount: number;
  lastErrorCode: string | null;
  updatedAt: number;
};

type PipelineWakeRow = {
  generation: number;
  enqueue_required: number;
  connectivity_epoch: number;
  active_attempt_token: string | null;
  active_attempt_generation: number | null;
  active_attempt_lease_until: number | null;
  last_reason: PipelineWakeReason | null;
  last_request_key: string | null;
  last_enqueued_generation: number | null;
  attempt_count: number;
  last_error_code: string | null;
  updated_at: number;
};

const toState = (row: PipelineWakeRow): PipelineWakeState => ({
  generation: Math.max(0, row.generation),
  enqueueRequired: row.enqueue_required === 1,
  connectivityEpoch: Math.max(0, row.connectivity_epoch),
  activeAttemptToken: row.active_attempt_token,
  activeAttemptGeneration: row.active_attempt_generation,
  activeAttemptLeaseUntil: row.active_attempt_lease_until,
  lastReason: row.last_reason,
  lastRequestKey: row.last_request_key,
  lastEnqueuedGeneration: row.last_enqueued_generation,
  attemptCount: Math.max(0, row.attempt_count),
  lastErrorCode: row.last_error_code,
  updatedAt: row.updated_at,
});

export async function getPipelineWakeState(): Promise<PipelineWakeState> {
  const db = await getDb();
  const row = await db.getFirstAsync<PipelineWakeRow>(
    `SELECT generation, enqueue_required, connectivity_epoch, active_attempt_token,
            active_attempt_generation, active_attempt_lease_until, last_reason,
            last_request_key, last_enqueued_generation, attempt_count, last_error_code, updated_at
     FROM pipeline_wake_state WHERE singleton_id = 1`,
  );
  if (!row) throw new Error('Pipeline wake state is unavailable.');
  return toState(row);
}

export async function requestPipelineWake(input: {
  reason: PipelineWakeReason;
  requestKey: string;
  connectivityRestored?: boolean;
}): Promise<PipelineWakeState & { newlyRequested: boolean }> {
  const db = await getDb();
  const now = Date.now();
  let newlyRequested = false;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await transaction.getFirstAsync<PipelineWakeRow>(
      `SELECT generation, enqueue_required, connectivity_epoch, active_attempt_token,
              active_attempt_generation, active_attempt_lease_until, last_reason,
              last_request_key, last_enqueued_generation, attempt_count, last_error_code, updated_at
       FROM pipeline_wake_state WHERE singleton_id = 1`,
    );
    if (!current) throw new Error('Pipeline wake state is unavailable.');
    const decision = requestWakeGeneration(toState(current) satisfies PipelineWakeSnapshot, {
      requestKey: input.requestKey,
      connectivityRestored: input.connectivityRestored === true,
    });
    newlyRequested = decision.newlyRequested;
    await transaction.runAsync(
      `UPDATE pipeline_wake_state
       SET generation = ?, enqueue_required = ?,
           connectivity_epoch = ?,
           last_reason = ?,
           last_request_key = ?,
           last_error_code = NULL,
           updated_at = ?
       WHERE singleton_id = 1`,
      [
        decision.generation,
        decision.enqueueRequired ? 1 : 0,
        decision.connectivityEpoch,
        input.reason,
        decision.lastRequestKey,
        now,
      ],
    );
  });
  return { ...await getPipelineWakeState(), newlyRequested };
}

export type PipelineWakeAttempt =
  | { status: 'claimed'; token: string; generation: number; connectivityEpoch: number }
  | { status: 'reclaimed'; token: string; generation: number; connectivityEpoch: number }
  | { status: 'busy'; generation: number }
  | { status: 'obsolete'; generation: number }
  | { status: 'no_work'; generation: number };

// The Worker retries at 15/30/60/... seconds. A live JS drain renews this
// every 15 seconds; a dead process becomes reclaimable before bounded native
// retries are exhausted.
export const PIPELINE_WAKE_LEASE_MS = 60_000;

export async function beginPipelineWakeAttempt(expectedGeneration: number): Promise<PipelineWakeAttempt> {
  const db = await getDb();
  const now = Date.now();
  const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  let result: PipelineWakeAttempt = { status: 'no_work', generation: expectedGeneration };
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const current = await transaction.getFirstAsync<PipelineWakeRow>(
      `SELECT generation, enqueue_required, connectivity_epoch, active_attempt_token,
              active_attempt_generation, active_attempt_lease_until, last_reason,
              last_request_key, last_enqueued_generation, attempt_count, last_error_code, updated_at
       FROM pipeline_wake_state WHERE singleton_id = 1`,
    );
    if (!current) return;
    const decision: PipelineWakeClaimDecision = decidePipelineWakeClaim(
      toState(current) satisfies PipelineWakeSnapshot,
      expectedGeneration,
      now,
    );
    if (decision.status !== 'claimed' && decision.status !== 'reclaimed') {
      result = { status: decision.status, generation: decision.generation };
      return;
    }
    await transaction.runAsync(
      `UPDATE pipeline_wake_state
       SET enqueue_required = 0, active_attempt_token = ?, active_attempt_generation = ?,
           active_attempt_lease_until = ?, last_started_at = ?,
           attempt_count = attempt_count + 1, updated_at = ?
       WHERE singleton_id = 1`,
      [token, expectedGeneration, now + PIPELINE_WAKE_LEASE_MS, now, now],
    );
    result = {
      status: decision.status,
      token,
      generation: current.generation,
      connectivityEpoch: current.connectivity_epoch,
    };
  });
  return result;
}

export async function renewPipelineWakeAttempt(token: string): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    `UPDATE pipeline_wake_state
     SET active_attempt_lease_until = ?, updated_at = ?
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
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    `UPDATE pipeline_wake_state
     SET active_attempt_token = NULL,
         active_attempt_generation = NULL,
         active_attempt_lease_until = NULL,
         enqueue_required = CASE WHEN ? = 1 THEN enqueue_required ELSE 1 END,
         last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END,
         last_error_code = ?, updated_at = ?
     WHERE singleton_id = 1 AND active_attempt_token = ?`,
    [input.succeeded ? 1 : 0, input.succeeded ? 1 : 0, now, input.errorCode ?? null, now, input.token],
  );
  return result.changes === 1;
}

export async function markPipelineWakeEnqueued(generation: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE pipeline_wake_state
     SET last_enqueued_at = ?, last_enqueued_generation = ?, updated_at = ?
     WHERE singleton_id = 1 AND generation = ?`,
    [Date.now(), generation, Date.now(), generation],
  );
}

const TRANSPORT_FAILURE_CLASSES: CloudFailureClass[] = ['offline', 'dns', 'tls', 'socket', 'timeout'];

export async function prepareTransportRetriesForConnectivityEpoch(epoch: number): Promise<void> {
  if (epoch <= 0) return;
  const db = await getDb();
  const placeholders = TRANSPORT_FAILURE_CLASSES.map(() => '?').join(', ');
  await db.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE meetings
       SET cloud_notes_next_retry_at = NULL, cloud_notes_last_wake_epoch = ?, updated_at = ?
       WHERE summary_status = 'retryable'
         AND cloud_notes_failure_class IN (${placeholders})
         AND cloud_notes_last_wake_epoch < ?`,
      [epoch, Date.now(), ...TRANSPORT_FAILURE_CLASSES, epoch],
    );
    await transaction.runAsync(
      `UPDATE meetings
       SET knowledge_cloud_next_retry_at = NULL, knowledge_cloud_last_wake_epoch = ?, updated_at = ?
       WHERE knowledge_cloud_sync_status = 'sync_failed_retryable'
         AND knowledge_cloud_failure_class IN (${placeholders})
         AND knowledge_cloud_last_wake_epoch < ?`,
      [epoch, Date.now(), ...TRANSPORT_FAILURE_CLASSES, epoch],
    );
  });
}
