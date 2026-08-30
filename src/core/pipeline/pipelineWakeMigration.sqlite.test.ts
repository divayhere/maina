// @ts-expect-error The app tsconfig intentionally excludes Node globals; this
// release-only fixture runs under Vitest's Node process.
import { spawnSync } from 'node:child_process';
// @ts-expect-error See the release-only Node fixture note above.
import { mkdtempSync, rmSync } from 'node:fs';
// @ts-expect-error See the release-only Node fixture note above.
import { tmpdir } from 'node:os';
// @ts-expect-error See the release-only Node fixture note above.
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  migratePipelineWakeV17,
  type PipelineWakeMigrationDatabase,
} from './pipelineWakeMigration';

const temporaryDirectories: string[] = [];

function sqlLiteral(value: string | number | null): string {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function bind(source: string, params: (string | number | null)[] = []): string {
  let index = 0;
  const bound = source.replaceAll('?', () => {
    if (index >= params.length) throw new Error('missing SQLite fixture bind value');
    return sqlLiteral(params[index++]);
  });
  if (index !== params.length) throw new Error('unused SQLite fixture bind value');
  return bound;
}

class SqliteCliDatabase implements PipelineWakeMigrationDatabase {
  constructor(private readonly path: string) {}

  private execute(source: string, json = false): string {
    const args = [...(json ? ['-json'] : []), this.path, source];
    const result = spawnSync('/usr/bin/sqlite3', args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`sqlite fixture failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async execAsync(source: string) {
    this.execute(source);
  }

  async getAllAsync<T>(source: string, params: (string | number | null)[] = []): Promise<T[]> {
    const output = this.execute(bind(source, params), true).trim();
    return output ? JSON.parse(output) as T[] : [];
  }

  async getFirstAsync<T>(source: string, params: (string | number | null)[] = []): Promise<T | null> {
    return (await this.getAllAsync<T>(source, params))[0] ?? null;
  }

  async runAsync(source: string, params: (string | number | null)[] = []) {
    this.execute(bind(source, params));
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('actual SQLite v16 to v17 wake migration', () => {
  it('reclaims the stale iPhone generation without changing packet or source identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'maina-v17-fixture-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'maina.db');
    const db = new SqliteCliDatabase(databasePath);
    const now = 1_777_777_777_000;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await db.execAsync(`
      PRAGMA user_version = 16;
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        summary_status TEXT NOT NULL,
        cloud_notes_job_id TEXT,
        knowledge_cloud_source_key TEXT
      );
      INSERT INTO meetings VALUES (
        'meeting-stale-ios', 'summarizing', 'running',
        'job-stable-opaque', 'meeting:maina:stable-source'
      );
      CREATE TABLE pipeline_wake_state (
        singleton_id INTEGER PRIMARY KEY NOT NULL,
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
      INSERT INTO pipeline_wake_state (
        singleton_id, requested_generation, completed_generation,
        enqueue_required, pending_requires_network,
        active_attempt_token, active_attempt_generation, active_attempt_lease_until,
        native_schedule_state, native_schedule_attempts,
        last_enqueued_generation, last_enqueued_work_id, updated_at
      ) VALUES (
        1, 3, 2, 1, 1,
        'stale-lease-token', 3, ${now - 60_000},
        'max_attempts', 5, 3, 'stale-native-request', ${now - 60_000}
      );
      CREATE TABLE knowledge_cloud_corrections (
        correction_key TEXT PRIMARY KEY NOT NULL,
        meeting_id TEXT NOT NULL,
        field_path TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        sync_status TEXT NOT NULL,
        last_attempt_at INTEGER
      );
    `);

    await migratePipelineWakeV17(db, now);
    await db.execAsync('PRAGMA user_version = 17;');
    const first = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM pipeline_wake_state WHERE singleton_id = 1',
    );
    // Restarting the migration is harmless and preserves the normalized tuple.
    await migratePipelineWakeV17(db, now);
    const second = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM pipeline_wake_state WHERE singleton_id = 1',
    );
    const meeting = await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM meetings WHERE id = \'meeting-stale-ios\'',
    );
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');

    expect(second).toEqual(first);
    expect(second).toEqual(expect.objectContaining({
      requested_generation: 3,
      completed_generation: 2,
      current_generation: 3,
      current_retry_not_before_at: now,
      pending_generation: null,
      pending_not_before_at: null,
      enqueue_required: 1,
      active_attempt_token: null,
      active_attempt_generation: null,
      active_attempt_lease_until: null,
      native_schedule_state: 'pending',
      native_schedule_attempts: 0,
      native_schedule_revision: 1,
    }));
    expect(meeting).toEqual({
      id: 'meeting-stale-ios',
      status: 'summarizing',
      summary_status: 'running',
      cloud_notes_job_id: 'job-stable-opaque',
      knowledge_cloud_source_key: 'meeting:maina:stable-source',
    });
    expect(version?.user_version).toBe(17);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
