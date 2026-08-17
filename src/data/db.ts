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

/** Ordered, append-only. Index in the array == schema version. */
const MIGRATIONS: string[] = [
  // v1 — meetings
  `CREATE TABLE IF NOT EXISTS meetings (
     id TEXT PRIMARY KEY NOT NULL,
     title TEXT NOT NULL,
     started_at INTEGER NOT NULL,
     duration_ms INTEGER NOT NULL DEFAULT 0,
     audio_uri TEXT,
     transcript TEXT,
     summary TEXT,
     language TEXT,
     status TEXT NOT NULL DEFAULT 'recorded'
   );`,
  // v2 — key/value settings
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY NOT NULL,
     value TEXT
   );`,
  // v3 — segmented recording + resumable transcription
  `ALTER TABLE meetings ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE meetings ADD COLUMN transcribed_segments INTEGER NOT NULL DEFAULT 0;`,
];

export async function initDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;
  if (current >= MIGRATIONS.length) {
    log.info('db', 'schema up to date', { version: current });
    return;
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    await db.execAsync(MIGRATIONS[v]);
    // user_version is an int pragma; template-literal is safe (v is a loop int).
    await db.execAsync(`PRAGMA user_version = ${v + 1};`);
    log.info('db', 'migrated', { to: v + 1 });
  }
}
