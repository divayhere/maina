/**
 * SQLite access + a tiny versioned migration runner.
 * Add a migration by appending to MIGRATIONS — never edit a shipped one — so
 * existing installs upgrade cleanly. Repositories build on top of this.
 */
import * as SQLite from 'expo-sqlite';
import { log } from '../services/logger';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync('maina.db');
  return dbPromise;
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
