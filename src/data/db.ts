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
