/**
 * SQLite access + a tiny versioned migration runner.
 * Add a migration by appending to MIGRATIONS — never edit a shipped one — so
 * existing installs upgrade cleanly. Repositories build on top of this.
 */
import * as SQLite from 'expo-sqlite';
import { log } from '../services/logger';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export const DURABLE_WAKE_BUSY_TIMEOUT_MS = 5_000;

type DurableWakeTransactionOptions = {
  openConnection?: () => Promise<SQLite.SQLiteDatabase>;
  busyTimeoutMs?: number;
};

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  // Android can keep the app process alive while React Native recreates its
  // runtime. expo-sqlite SDK 57 has an open issue around reusing a cached
  // native handle across that lifecycle. One fresh connection per JS runtime
  // avoids inheriting a released/poisoned handle; `dbPromise` still keeps one
  // connection for the lifetime of this runtime.
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync('maina.db', { useNewConnection: true });
  return dbPromise;
}

/**
 * Runs one short durable-wake read/modify/write transaction on the connection
 * that actually owns the write lock. Expo's exclusive helper begins a deferred
 * transaction on a fresh connection before callers can configure that handle;
 * two startup writers can therefore both read and then race while upgrading to
 * a write transaction. BEGIN IMMEDIATE acquires ownership before the first read.
 *
 * The finite busy timeout is SQLite's only bounded contention wait. Exhaustion
 * remains a truthful failure for the existing startup/periodic repair paths;
 * this helper never retries indefinitely or marks work complete after failure.
 */
export async function withDurableWakeTransaction<T>(
  task: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
  options: DurableWakeTransactionOptions = {},
): Promise<T> {
  const timeout = Math.max(
    0,
    Math.trunc(options.busyTimeoutMs ?? DURABLE_WAKE_BUSY_TIMEOUT_MS),
  );
  const transaction = await (options.openConnection?.()
    ?? SQLite.openDatabaseAsync('maina.db', { useNewConnection: true }));
  let began = false;
  let primaryFailure: unknown = null;

  try {
    await transaction.execAsync(`PRAGMA busy_timeout = ${timeout};`);
    await transaction.execAsync('PRAGMA foreign_keys = ON;');
    await transaction.execAsync('BEGIN IMMEDIATE;');
    began = true;
    const result = await task(transaction);
    await transaction.execAsync('COMMIT;');
    began = false;
    return result;
  } catch (cause) {
    primaryFailure = cause;
    if (began) {
      await transaction.execAsync('ROLLBACK;').catch(() => undefined);
      began = false;
    }
    throw cause;
  } finally {
    try {
      await transaction.closeAsync();
    } catch (closeFailure) {
      if (primaryFailure == null) throw closeFailure;
    }
  }
}

type Migration = (db: SQLite.SQLiteDatabase) => Promise<void>;

async function addColumnIfMissing(
  db: SQLite.SQLiteDatabase,
  table: string,
  column: string,
  declaration: string,
): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`);
  if (!columns.some((item) => item.name === column)) {
    await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
  }
}

/** Ordered, append-only. Index in the array == schema version. */
const MIGRATIONS: Migration[] = [
  // v1 — meetings
  async (db) => db.execAsync(`CREATE TABLE IF NOT EXISTS meetings (
     id TEXT PRIMARY KEY NOT NULL,
     title TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     audio_uri TEXT,
     transcript TEXT,
     summary TEXT,
     language TEXT,
     status TEXT NOT NULL DEFAULT 'recorded'
   );`),
  // v2 — key/value settings
  async (db) => db.execAsync(`CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT
   );`),
  // v3 — segmented recording + resumable transcription. The checks also
  // recover an old install where one ALTER succeeded before the app stopped.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'segment_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'transcribed_segments', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v4 — durable per-file checkpoints and recovery metadata.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'last_error', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'restart_count', 'INTEGER NOT NULL DEFAULT 0');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS recording_segments (
      meeting_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      audio_uri TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'recording',
      error_code TEXT,
      PRIMARY KEY (meeting_id, segment_index),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_recording_segments_meeting
      ON recording_segments(meeting_id, segment_index);`);
  },
  // v5 — block-based transcripts for long-session safety.
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS transcript_blocks (
      block_id TEXT PRIMARY KEY NOT NULL,
      meeting_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'final',
      segment_index INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      language TEXT,
      speaker_id TEXT,
      text TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_transcript_blocks_meeting_sequence
      ON transcript_blocks(meeting_id, sequence ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_blocks_unique_draft
      ON transcript_blocks(meeting_id)
      WHERE status = 'draft';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_blocks_unique_final_sequence
      ON transcript_blocks(meeting_id, sequence)
      WHERE status = 'final';`);
  },
  // v6 — meeting packet metadata + global todo rows.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'decisions_json', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'open_questions_json', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'summary_status', `TEXT NOT NULL DEFAULT 'idle'`);
    await addColumnIfMissing(db, 'meetings', 'summary_provider_id', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'summary_model', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'summarized_at', 'INTEGER');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS todo_items (
      id TEXT PRIMARY KEY NOT NULL,
      meeting_id TEXT NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      source_quote TEXT,
      source_speaker_id TEXT,
      source_timestamp INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'ai',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_todo_items_meeting_sort
      ON todo_items(meeting_id, done ASC, sort_order ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_todo_items_done
      ON todo_items(done ASC, updated_at DESC);`);
  },
  // v7 — Maina Knowledge Cloud sync state and frozen payload snapshot.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_sync_status', `TEXT NOT NULL DEFAULT 'local_only'`);
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_source_key', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_payload_json', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_synced_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_last_attempt_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_error', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_canonical_sha256', 'TEXT');
  },
  // v8 — immutable Maina Knowledge Cloud correction queue. Each row owns one
  // frozen request body so retries cannot mutate an already-issued key.
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS knowledge_cloud_corrections (
      correction_key TEXT PRIMARY KEY NOT NULL,
      meeting_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      field_path TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      version_tag TEXT NOT NULL,
      supersedes_correction_key TEXT,
      payload_json TEXT NOT NULL,
      value_fingerprint TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'sync_queued',
      canonical_sha256 TEXT,
      last_attempt_at INTEGER,
      synced_at INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      UNIQUE (meeting_id, field_path, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_cloud_corrections_pending
      ON knowledge_cloud_corrections(sync_status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_cloud_corrections_meeting_field
      ON knowledge_cloud_corrections(meeting_id, field_path, version_number DESC);`);
  },
  // v9 — durable capture timing + honest transcription progress.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'audio_duration_ms', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'capture_ended_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'transcription_window_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'transcription_completed_windows', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'transcription_failed_windows', 'INTEGER NOT NULL DEFAULT 0');
  },
  // v10 — native ASR writes to an isolated native outbox, then the foreground
  // app imports one immutable run into expo-sqlite. The imported run id makes
  // app restarts/retries idempotent without sharing SQLite handles.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'native_postprocess_run_id', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'native_postprocess_imported_at', 'INTEGER');
  },
  // v11 — independent, append-safe pipeline state. `meetings.status` remains
  // a convenient aggregate for legacy screens; this table is the durable
  // source for stage-local attempts, errors and honest unit progress.
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS meeting_pipeline_stages (
      meeting_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      last_error TEXT,
      completed_units INTEGER NOT NULL DEFAULT 0,
      total_units INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      PRIMARY KEY (meeting_id, stage),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_pipeline_stage_state
      ON meeting_pipeline_stages(stage, state, updated_at ASC);`);
  },
  // v12 — MKC owns the durable cloud-notes job. Android only retains its opaque
  // id and last poll time, so it can safely resume without holding provider
  // credentials or recomputing a finalized transcript.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_job_id', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_last_polled_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_retry_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_last_retry_at', 'INTEGER');
  },
  // v13 — bounded native-ASR recovery progress. This counter is copied from
  // the native outbox so the UI and notes queue can distinguish "retrying"
  // from a terminal, usable partial transcript after the retry budget ends.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'transcription_recovery_rounds', 'INTEGER NOT NULL DEFAULT 0');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS local_asr_windows (
      meeting_id TEXT NOT NULL,
      window_key TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      window_index INTEGER NOT NULL,
      started_ms INTEGER NOT NULL,
      ended_ms INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY (meeting_id, window_key),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_local_asr_windows_meeting
      ON local_asr_windows(meeting_id, chunk_index, window_index);`);
  },
  // v14 — durable cloud-note retry scheduling. A network or process failure
  // must survive app restarts without being presented as a terminal failure.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_next_retry_at', 'INTEGER');
    await db.execAsync(`CREATE INDEX IF NOT EXISTS idx_meetings_cloud_notes_retry
      ON meetings(summary_status, cloud_notes_next_retry_at);`);
  },
  // v15 — disposable, owner-scoped MKC read cache. This table never owns
  // recordings, transcripts, notes, sync outbox state, or authentication.
  async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS mkc_memory_cache (
      owner_user_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      resource_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      etag TEXT,
      checksum TEXT,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_accessed_at INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mkc_memory_cache_owner_access
      ON mkc_memory_cache(owner_user_id, last_accessed_at DESC);`);
  },
  // v16 — one durable recovery/wake truth shared by foreground, connectivity,
  // and OS workers. This is the only post-v15 migration in the release: the
  // earlier v17 draft never shipped and was consolidated here before build.
  async (db) => {
    await addColumnIfMissing(db, 'meetings', 'capture_disposition', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'capture_pause_reason', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'capture_gap_ms', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'capture_heartbeat_terminal_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_failure_class', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_failure_operation', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'cloud_notes_last_wake_epoch', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_failure_class', 'TEXT');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_retry_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_next_retry_at', 'INTEGER');
    await addColumnIfMissing(db, 'meetings', 'knowledge_cloud_last_wake_epoch', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'audio_cleanup_state', `TEXT NOT NULL DEFAULT 'not_due'`);
    await addColumnIfMissing(db, 'meetings', 'audio_cleanup_retry_count', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'meetings', 'audio_cleanup_next_retry_at', 'INTEGER');
    await db.execAsync(`CREATE TABLE IF NOT EXISTS pipeline_wake_state (
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
      signal_sequence INTEGER NOT NULL DEFAULT 0,
      requested_generation INTEGER NOT NULL DEFAULT 0,
      completed_generation INTEGER NOT NULL DEFAULT 0,
      enqueue_required INTEGER NOT NULL DEFAULT 0,
      connectivity_epoch INTEGER NOT NULL DEFAULT 0,
      last_connected INTEGER,
      pending_requires_network INTEGER NOT NULL DEFAULT 0,
      active_attempt_token TEXT,
      active_attempt_generation INTEGER,
      active_attempt_lease_until INTEGER,
      last_reason TEXT,
      native_schedule_state TEXT NOT NULL DEFAULT 'idle',
      native_schedule_attempts INTEGER NOT NULL DEFAULT 0,
      last_enqueued_generation INTEGER,
      last_enqueued_work_id TEXT,
      last_enqueued_at INTEGER,
      last_started_at INTEGER,
      last_completed_at INTEGER,
      last_error_code TEXT,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO pipeline_wake_state
      (singleton_id, signal_sequence, requested_generation, completed_generation,
       enqueue_required, connectivity_epoch, pending_requires_network,
       native_schedule_state, native_schedule_attempts, updated_at)
      VALUES (1, 0, 0, 0, 0, 0, 0, 'idle', 0, 0);

    CREATE TABLE IF NOT EXISTS local_asr_run_claims (
      meeting_id TEXT PRIMARY KEY NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      state TEXT NOT NULL DEFAULT 'deferred',
      claimed_at INTEGER,
      invalidated_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_local_asr_run_claim_state
      ON local_asr_run_claims(state, updated_at ASC);
    `);
    await addColumnIfMissing(db, 'local_asr_windows', 'asr_generation', 'INTEGER NOT NULL DEFAULT 0');
    await addColumnIfMissing(db, 'local_asr_windows', 'claim_token', 'TEXT');
    await addColumnIfMissing(db, 'local_asr_windows', 'claim_state', `TEXT NOT NULL DEFAULT 'committed'`);
    await addColumnIfMissing(db, 'local_asr_windows', 'claimed_at', 'INTEGER');
    await addColumnIfMissing(db, 'local_asr_windows', 'lease_until', 'INTEGER');
    await addColumnIfMissing(db, 'local_asr_windows', 'committed_at', 'INTEGER');
    await db.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_meetings_cloud_transport_retry
      ON meetings(summary_status, cloud_notes_failure_class, cloud_notes_next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_meetings_source_transport_retry
      ON meetings(knowledge_cloud_sync_status, knowledge_cloud_failure_class, knowledge_cloud_next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_meetings_audio_cleanup
      ON meetings(audio_cleanup_state, audio_cleanup_next_retry_at);

    UPDATE meetings
      SET knowledge_cloud_error = 'Waiting for internet. Maina will continue automatically.'
      WHERE knowledge_cloud_sync_status = 'sync_failed_retryable';
    UPDATE meetings
      SET last_error = 'Waiting for internet. Maina will continue automatically.'
      WHERE summary_status = 'retryable';`);
  },
];

export async function initDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.execAsync('PRAGMA busy_timeout = 5000;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;
  if (current >= MIGRATIONS.length) {
    log.info('db', 'schema up to date', { version: current });
    return;
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.withTransactionAsync(async () => {
      await MIGRATIONS[v](db);
      // user_version is an int pragma; template-literal is safe (v is a loop int).
      await db.execAsync(`PRAGMA user_version = ${v + 1};`);
    });
    log.info('db', 'migrated', { to: v + 1 });
  }
}
