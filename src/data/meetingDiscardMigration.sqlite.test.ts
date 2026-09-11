// @ts-expect-error Node built-ins are test-only and absent from the mobile tsconfig.
import { execFileSync } from 'node:child_process';
// @ts-expect-error Node built-ins are test-only and absent from the mobile tsconfig.
import { mkdtempSync, rmSync } from 'node:fs';
// @ts-expect-error Node built-ins are test-only and absent from the mobile tsconfig.
import { tmpdir } from 'node:os';
// @ts-expect-error Node built-ins are test-only and absent from the mobile tsconfig.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MEETING_DISCARD_V21_MIGRATION_SQL } from './meetingDiscardMigration';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maina-discard-v21-'));
  roots.push(root);
  const path = join(root, 'maina.db');
  const run = (sql: string) => execFileSync('/usr/bin/sqlite3', [path], {
    encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'],
  });
  run(`PRAGMA foreign_keys=ON;
    CREATE TABLE meetings (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE recording_segments (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      segment_index INTEGER NOT NULL,
      PRIMARY KEY(meeting_id, segment_index)
    );
    INSERT INTO meetings VALUES ('meeting-1');
    INSERT INTO recording_segments VALUES ('meeting-1', 0);
    ${MEETING_DISCARD_V21_MIGRATION_SQL}`);
  return { path, run };
}

describe('actual SQLite v21 meeting Discard tombstone', () => {
  it('atomically hides the meeting and retains an independent replay tombstone', () => {
    const db = fixture();
    db.run(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
      INSERT INTO meeting_discard_tombstones
        (meeting_id, discard_id, capture_directory, capture_generation, requested_at)
      VALUES ('meeting-1', 'discard-1', '/private/capture-1', 1, 100);
      DELETE FROM meetings WHERE id='meeting-1';
      COMMIT;`);
    const rows = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', db.path], {
      encoding: 'utf8', input: `SELECT
        (SELECT count(*) FROM meetings) AS meetings,
        (SELECT count(*) FROM recording_segments) AS segments,
        (SELECT count(*) FROM meeting_discard_tombstones) AS tombstones;`,
    })) as { meetings: number; segments: number; tombstones: number }[];
    expect(rows).toEqual([{ meetings: 0, segments: 0, tombstones: 1 }]);
  });

  it('enforces one global unresolved discard owner and rolls back a failed competitor', () => {
    const db = fixture();
    db.run(`INSERT INTO meeting_discard_tombstones
      (meeting_id, discard_id, capture_directory, capture_generation, requested_at)
      VALUES ('meeting-1', 'discard-1', '/private/capture-1', 1, 100);`);
    expect(() => db.run(`BEGIN IMMEDIATE;
      INSERT INTO meeting_discard_tombstones
        (meeting_id, discard_id, capture_directory, capture_generation, requested_at)
      VALUES ('meeting-2', 'discard-2', '/private/capture-2', 2, 101);
      COMMIT;`)).toThrow();
    const count = execFileSync('/usr/bin/sqlite3', [db.path], {
      encoding: 'utf8', input: 'SELECT count(*) FROM meeting_discard_tombstones;',
    }).trim();
    expect(count).toBe('1');
  });
});
