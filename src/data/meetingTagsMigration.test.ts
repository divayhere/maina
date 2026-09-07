// @ts-expect-error Node built-ins are test-only and intentionally absent from the mobile tsconfig types.
import { execFileSync } from 'node:child_process';
// @ts-expect-error Node built-ins are test-only and intentionally absent from the mobile tsconfig types.
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import example from '../../contracts/mkc-meeting-tags/maina-meeting-tags.v1.json';
import type { MeetingTagMutationRequestV1 } from '@/contracts/mkc-meeting-tags.generated';
import {
  canonicalMeetingTagMutationReceiptJson,
  canonicalMeetingTagMutationRequestJson,
  meetingTagMutationSubjectKey,
} from '@/services/mkc-meeting-tags-core';
import {
  MEETING_TAG_OUTBOX_V18_MIGRATION_SQL,
  migrateMeetingTagOutboxV19,
} from './meetingTagsMigration';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { force: true, recursive: true });
});

function sqliteQuote(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error('unsupported SQLite fixture value');
}

function bind(source: string, params: unknown[] = []): string {
  let index = 0;
  const bound = source.replaceAll('?', () => {
    if (index >= params.length) throw new Error('missing SQLite fixture binding');
    return sqliteQuote(params[index++]);
  });
  if (index !== params.length) throw new Error('extra SQLite fixture binding');
  return bound;
}

function createActualSqliteAdapter() {
  const root = execFileSync('/usr/bin/mktemp', ['-d', '/tmp/maina-tag-v19.XXXXXX'], {
    encoding: 'utf8',
  }).trim();
  tempRoots.push(root);
  const path = `${root}/maina.db`;
  const execute = (source: string) => execFileSync('/usr/bin/sqlite3', [path], {
    encoding: 'utf8',
    input: source,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    path,
    execute,
    db: {
      execAsync: async (source: string) => { execute(source); },
      getAllAsync: async <T>(source: string, params: unknown[] = []) => {
        const output = execFileSync('/usr/bin/sqlite3', ['-json', path], {
          encoding: 'utf8',
          input: bind(source, params),
        }).trim();
        return (output.length === 0 ? [] : JSON.parse(output)) as T[];
      },
      runAsync: async (source: string, params: unknown[] = []) => {
        execute(bind(source, params));
        return {};
      },
    },
  };
}

const queuedCreate = {
  schema_version: 'mkc.meeting-tag-mutation-request.v1',
  idempotency_key: 'mobile-outbox:migration:0001',
  operation: { kind: 'create_definition', display_label: ' Dubai ' },
};

describe('meeting-tag outbox v18 to v19 migration', () => {
  it('rebuilds an actual v18 SQLite table, preserves rowid, and installs final constraints', async () => {
    const actual = createActualSqliteAdapter();
    actual.execute(MEETING_TAG_OUTBOX_V18_MIGRATION_SQL);
    const requestJson = canonicalMeetingTagMutationRequestJson(queuedCreate);
    actual.execute(`INSERT INTO meeting_tag_outbox
      (rowid, idempotency_key, owner_user_id, request_json, operation_kind,
       state, attempt_count, created_at, updated_at)
      VALUES (41, 'mobile-outbox:migration:0001', 'owner:migration',
        ${sqliteQuote(requestJson)}, 'create_definition', 'queued', 0, 100, 100);`);
    const removeRequestJson = canonicalMeetingTagMutationRequestJson(example.remove_request);
    const removeReceiptJson = canonicalMeetingTagMutationReceiptJson(
      example.remove_receipt,
      example.remove_request as MeetingTagMutationRequestV1,
    );
    actual.execute(`INSERT INTO meeting_tag_outbox
      (rowid, idempotency_key, owner_user_id, request_json, operation_kind,
       meeting_id, source_key, tag_id, state, attempt_count, receipt_json, created_at, updated_at)
      VALUES (42, ${sqliteQuote(example.remove_request.idempotency_key)}, 'owner:migration',
        ${sqliteQuote(removeRequestJson)}, 'remove',
        ${sqliteQuote(example.remove_request.operation.meeting_id)},
        ${sqliteQuote(example.remove_request.operation.source_key)},
        ${sqliteQuote(example.remove_request.operation.tag_id)},
        'succeeded', 1, ${sqliteQuote(removeReceiptJson)}, 110, 120);`);

    await migrateMeetingTagOutboxV19(actual.db as never);

    const row = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', actual.path], {
      encoding: 'utf8',
      input: 'SELECT rowid, subject_key, reconciliation_json FROM meeting_tag_outbox;',
    })) as { rowid: number; subject_key: string; reconciliation_json: null }[];
    expect(row).toEqual([
      {
        rowid: 41,
        subject_key: meetingTagMutationSubjectKey(queuedCreate),
        reconciliation_json: null,
      },
      {
        rowid: 42,
        subject_key: meetingTagMutationSubjectKey(example.remove_request),
        reconciliation_json: null,
      },
    ]);
    const columnNames = JSON.parse(execFileSync('/usr/bin/sqlite3', ['-json', actual.path], {
      encoding: 'utf8',
      input: 'SELECT name FROM pragma_table_info(\'meeting_tag_outbox\') ORDER BY cid;',
    })) as { name: string }[];
    expect(columnNames.map((column) => column.name)).toContain('subject_key');
    expect(columnNames.map((column) => column.name)).toContain('reconciliation_json');
    expect(() => actual.execute(
      "UPDATE meeting_tag_outbox SET subject_key = 'changed' WHERE rowid = 41;",
    )).toThrow(/meeting_tag_outbox_identity_immutable/);
  });

  it('fails before rebuilding when legacy unresolved rows collapse to one canonical subject', async () => {
    const actual = createActualSqliteAdapter();
    actual.execute(MEETING_TAG_OUTBOX_V18_MIGRATION_SQL);
    const firstJson = canonicalMeetingTagMutationRequestJson(queuedCreate);
    const second = {
      ...queuedCreate,
      idempotency_key: 'mobile-outbox:migration:0002',
      operation: { kind: 'create_definition', display_label: 'ＤＵＢＡＩ' },
    };
    const secondJson = canonicalMeetingTagMutationRequestJson(second);
    actual.execute(`INSERT INTO meeting_tag_outbox
      (idempotency_key, owner_user_id, request_json, operation_kind,
       state, attempt_count, created_at, updated_at)
      VALUES
      ('mobile-outbox:migration:0001', 'owner:migration', ${sqliteQuote(firstJson)},
       'create_definition', 'queued', 0, 100, 100),
      ('mobile-outbox:migration:0002', 'owner:migration', ${sqliteQuote(secondJson)},
       'create_definition', 'queued', 0, 101, 101);`);
    await expect(migrateMeetingTagOutboxV19(actual.db as never))
      .rejects.toThrow('meeting_tag_outbox_v19_duplicate_unresolved_subject');
    expect(actual.execute(
      "SELECT COUNT(*) FROM pragma_table_info('meeting_tag_outbox') WHERE name IN ('subject_key', 'reconciliation_json');",
    ).trim()).toBe('0');
  });
});
