export type LegacyPipelineWakeV16Row = {
  requestedGeneration: number;
  completedGeneration: number;
  currentGeneration?: number | null;
  currentRetryNotBeforeAt?: number | null;
  pendingGeneration?: number | null;
  pendingNotBeforeAt?: number | null;
  nativeScheduleState: string;
  nativeScheduleAttempts: number;
  nativeScheduleRevision?: number | null;
};

export type PipelineWakeV17Normalization = {
  currentGeneration: number | null;
  currentRetryNotBeforeAt: number | null;
  pendingGeneration: number | null;
  pendingNotBeforeAt: number | null;
  enqueueRequired: boolean;
  nativeScheduleState: 'idle' | 'pending';
  nativeScheduleAttempts: number;
  nativeScheduleRevision: number;
};

type MigrationValue = string | number | null;
export type PipelineWakeMigrationDatabase = {
  execAsync(source: string): Promise<unknown>;
  getAllAsync<T>(source: string, params?: MigrationValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params?: MigrationValue[]): Promise<T | null>;
  runAsync(source: string, params?: MigrationValue[]): Promise<unknown>;
};

async function addColumnIfMissing(
  db: PipelineWakeMigrationDatabase,
  table: string,
  column: string,
  declaration: string,
) {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (!columns.some((item) => item.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
  }
}

/**
 * Normalizes the v16 single-generation row after an in-place upgrade. The old
 * process cannot still own its lease once the new binary runs this migration.
 */
export function normalizePipelineWakeV17(
  row: LegacyPipelineWakeV16Row,
  now: number,
): PipelineWakeV17Normalization {
  const unfinished = row.requestedGeneration > row.completedGeneration;
  if (!unfinished) {
    return {
      currentGeneration: null,
      currentRetryNotBeforeAt: null,
      pendingGeneration: null,
      pendingNotBeforeAt: null,
      enqueueRequired: false,
      nativeScheduleState: 'idle',
      nativeScheduleAttempts: 0,
      nativeScheduleRevision: Math.max(0, row.nativeScheduleRevision ?? 0),
    };
  }

  const currentGeneration = row.currentGeneration ?? row.completedGeneration + 1;
  const pendingGeneration = row.pendingGeneration
    ?? (row.requestedGeneration > currentGeneration ? currentGeneration + 1 : null);
  const wasLegacy = row.currentGeneration == null;
  return {
    currentGeneration,
    currentRetryNotBeforeAt: wasLegacy
      ? now
      : row.currentRetryNotBeforeAt ?? now,
    pendingGeneration,
    pendingNotBeforeAt: pendingGeneration == null
      ? null
      : row.pendingNotBeforeAt ?? now,
    enqueueRequired: true,
    nativeScheduleState: 'pending',
    nativeScheduleAttempts: 0,
    nativeScheduleRevision: Math.max(0, row.nativeScheduleRevision ?? 0)
      + (wasLegacy || row.nativeScheduleState === 'max_attempts' ? 1 : 0),
  };
}

/**
 * The production v16→v17 migration as one adapter-driven operation. Keeping
 * the SQL here lets the release gate execute this exact code against a real
 * SQLite v16 fixture instead of validating only a pure normalization helper.
 */
export async function migratePipelineWakeV17(
  db: PipelineWakeMigrationDatabase,
  now = Date.now(),
): Promise<void> {
  await addColumnIfMissing(db, 'pipeline_wake_state', 'current_generation', 'INTEGER');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'current_retry_not_before_at', 'INTEGER');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'pending_generation', 'INTEGER');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'pending_not_before_at', 'INTEGER');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'native_schedule_revision', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'last_enqueued_schedule_revision', 'INTEGER');
  await addColumnIfMissing(db, 'pipeline_wake_state', 'last_enqueued_not_before_at', 'INTEGER');

  await addColumnIfMissing(db, 'knowledge_cloud_corrections', 'failure_class', 'TEXT');
  await addColumnIfMissing(db, 'knowledge_cloud_corrections', 'retry_count', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(db, 'knowledge_cloud_corrections', 'last_retry_at', 'INTEGER');
  await addColumnIfMissing(db, 'knowledge_cloud_corrections', 'next_retry_at', 'INTEGER');
  await addColumnIfMissing(db, 'knowledge_cloud_corrections', 'last_wake_epoch', 'INTEGER NOT NULL DEFAULT 0');

  const legacyWake = await db.getFirstAsync<{
    requested_generation: number;
    completed_generation: number;
    current_generation: number | null;
    current_retry_not_before_at: number | null;
    pending_generation: number | null;
    pending_not_before_at: number | null;
    native_schedule_state: string;
    native_schedule_attempts: number;
    native_schedule_revision: number;
  }>(`SELECT requested_generation, completed_generation, current_generation,
    current_retry_not_before_at, pending_generation, pending_not_before_at,
    native_schedule_state, native_schedule_attempts, native_schedule_revision
    FROM pipeline_wake_state WHERE singleton_id = 1`);
  const normalizedWake = legacyWake ? normalizePipelineWakeV17({
    requestedGeneration: legacyWake.requested_generation,
    completedGeneration: legacyWake.completed_generation,
    currentGeneration: legacyWake.current_generation,
    currentRetryNotBeforeAt: legacyWake.current_retry_not_before_at,
    pendingGeneration: legacyWake.pending_generation,
    pendingNotBeforeAt: legacyWake.pending_not_before_at,
    nativeScheduleState: legacyWake.native_schedule_state,
    nativeScheduleAttempts: legacyWake.native_schedule_attempts,
    nativeScheduleRevision: legacyWake.native_schedule_revision,
  }, now) : null;
  if (normalizedWake) await db.runAsync(
    `UPDATE pipeline_wake_state SET
      current_generation = ?, current_retry_not_before_at = ?,
      pending_generation = ?, pending_not_before_at = ?, enqueue_required = ?,
      active_attempt_token = NULL,
      active_attempt_generation = NULL,
      active_attempt_lease_until = NULL,
      native_schedule_state = ?, native_schedule_attempts = ?, native_schedule_revision = ?,
      last_enqueued_schedule_revision = NULL,
      last_enqueued_not_before_at = NULL,
      last_error_code = NULL,
      updated_at = ?
     WHERE singleton_id = 1`,
    [
      normalizedWake.currentGeneration,
      normalizedWake.currentRetryNotBeforeAt,
      normalizedWake.pendingGeneration,
      normalizedWake.pendingNotBeforeAt,
      normalizedWake.enqueueRequired ? 1 : 0,
      normalizedWake.nativeScheduleState,
      normalizedWake.nativeScheduleAttempts,
      normalizedWake.nativeScheduleRevision,
      now,
    ],
  );
  await db.runAsync(
    `UPDATE knowledge_cloud_corrections SET
      failure_class = COALESCE(failure_class, 'backend_retryable'),
      retry_count = CASE WHEN retry_count < 1 THEN 1 ELSE retry_count END,
      last_retry_at = COALESCE(last_retry_at, last_attempt_at, ?),
      next_retry_at = COALESCE(next_retry_at, ?)
     WHERE sync_status IN ('sync_failed_retryable', 'sync_blocked_budget')`,
    [now, now],
  );
  await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_cloud_corrections_retry
      ON knowledge_cloud_corrections(sync_status, next_retry_at, meeting_id, field_path, version_number);
  `);
}
