import type {
  MeetingTagDefinitionListV1,
  MeetingTagMutationRequestV1,
  MeetingTagStateV1,
} from '@/contracts/mkc-meeting-tags.generated';
import type { SQLiteBindParams } from 'expo-sqlite';
import {
  canonicalMeetingTagDefinitionsJson,
  canonicalMeetingTagMutationReceiptJson,
  canonicalMeetingTagMutationRequestJson,
  canonicalMeetingTagStateJson,
  decodeMeetingTagDefinitions,
  decodeMeetingTagMutationReceipt,
  decodeMeetingTagMutationRequest,
  decodeMeetingTagState,
  meetingTagMutationSubjectKey,
} from '@/services/mkc-meeting-tags-core';

/** Immutable v18 bytes. Never extend this schema in place. */
export const MEETING_TAG_OUTBOX_V18_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS meeting_tag_outbox (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN ('create_definition', 'rename_definition', 'assign', 'remove')),
  meeting_id TEXT,
  source_key TEXT,
  tag_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'retryable', 'succeeded', 'conflict', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  receipt_json TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'offline', 'transport_retryable', 'http_retryable', 'revision_conflict',
    'auth_required', 'validation_rejected', 'protocol_rejected'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (operation_kind = 'create_definition'
      AND meeting_id IS NULL AND source_key IS NULL AND tag_id IS NULL)
    OR (operation_kind = 'rename_definition'
      AND meeting_id IS NULL AND source_key IS NULL AND tag_id IS NOT NULL)
    OR (operation_kind IN ('assign', 'remove')
      AND meeting_id IS NOT NULL AND source_key IS NOT NULL AND tag_id IS NOT NULL
      AND meeting_id = source_key)
  ),
  CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    (state = 'succeeded' AND receipt_json IS NOT NULL AND failure_code IS NULL)
    OR (state <> 'succeeded' AND receipt_json IS NULL)
  ),
  CHECK (
    (state IN ('queued', 'running') AND next_attempt_at IS NULL AND failure_code IS NULL)
    OR (state = 'retryable' AND next_attempt_at IS NOT NULL
      AND failure_code IN ('offline', 'transport_retryable', 'http_retryable'))
    OR (state = 'succeeded' AND next_attempt_at IS NULL AND failure_code IS NULL)
    OR (state = 'conflict' AND next_attempt_at IS NULL AND failure_code = 'revision_conflict')
    OR (state = 'terminal' AND next_attempt_at IS NULL
      AND failure_code IN ('auth_required', 'validation_rejected', 'protocol_rejected'))
  )
);
CREATE INDEX IF NOT EXISTS idx_meeting_tag_outbox_owner_due
  ON meeting_tag_outbox(owner_user_id, state, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_meeting_tag_outbox_subject
  ON meeting_tag_outbox(owner_user_id, meeting_id, tag_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS meeting_tag_outbox_immutable_request
  BEFORE UPDATE OF idempotency_key, owner_user_id, request_json, operation_kind,
    meeting_id, source_key, tag_id, created_at
  ON meeting_tag_outbox
  WHEN OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.owner_user_id IS NOT NEW.owner_user_id
    OR OLD.request_json IS NOT NEW.request_json
    OR OLD.operation_kind IS NOT NEW.operation_kind
    OR OLD.meeting_id IS NOT NEW.meeting_id
    OR OLD.source_key IS NOT NEW.source_key
    OR OLD.tag_id IS NOT NEW.tag_id
    OR OLD.created_at IS NOT NEW.created_at
  BEGIN
    SELECT RAISE(ABORT, 'meeting_tag_outbox_identity_immutable');
  END;
CREATE TRIGGER IF NOT EXISTS meeting_tag_outbox_state_transition
  BEFORE UPDATE OF state ON meeting_tag_outbox
  WHEN NOT (
    (OLD.state = 'queued' AND NEW.state = 'running')
    OR (OLD.state = 'running' AND NEW.state IN (
      'running', 'retryable', 'succeeded', 'conflict', 'terminal'
    ))
    OR (OLD.state = 'retryable' AND NEW.state = 'running')
    OR (OLD.state = 'conflict' AND NEW.state = 'terminal')
  )
  BEGIN
    SELECT RAISE(ABORT, 'meeting_tag_outbox_state_transition_invalid');
  END;`;

export const MEETING_TAG_OUTBOX_V19_TABLE_SQL = `CREATE TABLE meeting_tag_outbox (
  idempotency_key TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  operation_kind TEXT NOT NULL
    CHECK (operation_kind IN ('create_definition', 'rename_definition', 'assign', 'remove')),
  meeting_id TEXT,
  source_key TEXT,
  tag_id TEXT,
  subject_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN (
      'queued', 'running', 'retryable', 'succeeded', 'conflict', 'reconciled', 'terminal'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  receipt_json TEXT,
  reconciliation_json TEXT,
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'offline', 'transport_retryable', 'http_retryable', 'revision_conflict',
    'auth_required', 'validation_rejected', 'protocol_rejected'
  )),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (operation_kind = 'create_definition'
      AND meeting_id IS NULL AND source_key IS NULL AND tag_id IS NULL)
    OR (operation_kind = 'rename_definition'
      AND meeting_id IS NULL AND source_key IS NULL AND tag_id IS NOT NULL)
    OR (operation_kind IN ('assign', 'remove')
      AND meeting_id IS NOT NULL AND source_key IS NOT NULL AND tag_id IS NOT NULL
      AND meeting_id = source_key)
  ),
  CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    (state = 'succeeded' AND receipt_json IS NOT NULL AND failure_code IS NULL)
    OR (state <> 'succeeded' AND receipt_json IS NULL)
  ),
  CHECK (
    (state = 'reconciled' AND reconciliation_json IS NOT NULL)
    OR (state <> 'reconciled' AND reconciliation_json IS NULL)
  ),
  CHECK (
    (state IN ('queued', 'running') AND next_attempt_at IS NULL AND failure_code IS NULL)
    OR (state = 'retryable' AND next_attempt_at IS NOT NULL
      AND failure_code IN ('offline', 'transport_retryable', 'http_retryable'))
    OR (state = 'succeeded' AND next_attempt_at IS NULL AND failure_code IS NULL)
    OR (state = 'conflict' AND next_attempt_at IS NULL AND failure_code = 'revision_conflict')
    OR (state = 'reconciled' AND next_attempt_at IS NULL AND failure_code IS NULL)
    OR (state = 'terminal' AND next_attempt_at IS NULL
      AND failure_code IN ('auth_required', 'validation_rejected', 'protocol_rejected'))
  )
);`;

export const MEETING_TAG_OUTBOX_V19_FINALIZE_SQL = `CREATE INDEX idx_meeting_tag_outbox_owner_due
  ON meeting_tag_outbox(owner_user_id, state, next_attempt_at, created_at);
CREATE INDEX idx_meeting_tag_outbox_subject
  ON meeting_tag_outbox(owner_user_id, subject_key, state);
CREATE TRIGGER meeting_tag_outbox_immutable_request
  BEFORE UPDATE OF idempotency_key, owner_user_id, request_json, operation_kind,
    meeting_id, source_key, tag_id, subject_key, created_at
  ON meeting_tag_outbox
  WHEN OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.owner_user_id IS NOT NEW.owner_user_id
    OR OLD.request_json IS NOT NEW.request_json
    OR OLD.operation_kind IS NOT NEW.operation_kind
    OR OLD.meeting_id IS NOT NEW.meeting_id
    OR OLD.source_key IS NOT NEW.source_key
    OR OLD.tag_id IS NOT NEW.tag_id
    OR OLD.subject_key IS NOT NEW.subject_key
    OR OLD.created_at IS NOT NEW.created_at
  BEGIN
    SELECT RAISE(ABORT, 'meeting_tag_outbox_identity_immutable');
  END;
CREATE TRIGGER meeting_tag_outbox_state_transition
  BEFORE UPDATE OF state ON meeting_tag_outbox
  WHEN NOT (
    (OLD.state = 'queued' AND NEW.state = 'running')
    OR (OLD.state = 'running' AND NEW.state IN (
      'running', 'retryable', 'succeeded', 'conflict', 'terminal'
    ))
    OR (OLD.state = 'retryable' AND NEW.state = 'running')
    OR (OLD.state = 'conflict' AND NEW.state = 'reconciled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'meeting_tag_outbox_state_transition_invalid');
  END;`;

type MigrationDb = {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string, params?: SQLiteBindParams): Promise<T[]>;
  runAsync(source: string, params?: SQLiteBindParams): Promise<unknown>;
};

type LegacyOutboxRow = {
  source_rowid: number;
  idempotency_key: string;
  owner_user_id: string;
  request_json: string;
  operation_kind: string;
  meeting_id: string | null;
  source_key: string | null;
  tag_id: string | null;
  subject_key?: string | null;
  state: string;
  attempt_count: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  receipt_json: string | null;
  reconciliation_json?: string | null;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
};

type PreparedOutboxRow = LegacyOutboxRow & {
  subject_key: string;
  reconciliation_json: string | null;
};

const legacyStates = new Set([
  'queued', 'running', 'retryable', 'succeeded', 'conflict', 'reconciled', 'terminal',
]);
const retryableFailures = new Set(['offline', 'transport_retryable', 'http_retryable']);
const terminalFailures = new Set(['auth_required', 'validation_rejected', 'protocol_rejected']);
const leasePattern = /^[A-Za-z0-9._:-]{1,128}$/u;

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
}

function requestIdentity(request: MeetingTagMutationRequestV1) {
  const operation = request.operation;
  return {
    operationKind: operation.kind,
    meetingId: 'meeting_id' in operation ? operation.meeting_id : null,
    sourceKey: 'source_key' in operation ? operation.source_key : null,
    tagId: 'tag_id' in operation ? operation.tag_id : null,
  };
}

function canonicalReconciliationJson(request: MeetingTagMutationRequestV1, value: unknown): string {
  if (request.operation.kind === 'create_definition' || request.operation.kind === 'rename_definition') {
    return canonicalMeetingTagDefinitionsJson(decodeMeetingTagDefinitions(value) as MeetingTagDefinitionListV1);
  }
  return canonicalMeetingTagStateJson(
    decodeMeetingTagState(value, request.operation.source_key) as MeetingTagStateV1,
    request.operation.source_key,
  );
}

function prepareLegacyRow(row: LegacyOutboxRow, hasSubject: boolean, hasReconciliation: boolean): PreparedOutboxRow {
  if (!Number.isSafeInteger(row.source_rowid) || row.source_rowid < 1
    || typeof row.owner_user_id !== 'string' || row.owner_user_id.length < 1
    || row.owner_user_id.length > 200 || row.owner_user_id.trim() !== row.owner_user_id
    || !legacyStates.has(row.state)
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0
    || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at
    || (row.next_attempt_at !== null
      && (!Number.isSafeInteger(row.next_attempt_at) || row.next_attempt_at < 0))) {
    throw new Error('meeting_tag_outbox_v19_invalid_legacy_row');
  }
  if (row.state === 'running') {
    if (typeof row.lease_token !== 'string' || !leasePattern.test(row.lease_token)
      || !Number.isSafeInteger(row.lease_until) || (row.lease_until ?? -1) < 0) {
      throw new Error('meeting_tag_outbox_v19_invalid_running_lease');
    }
  } else if (row.lease_token !== null || row.lease_until !== null) {
    throw new Error('meeting_tag_outbox_v19_unexpected_lease');
  }
  const validStateTruth = (['queued', 'running'].includes(row.state)
      && row.next_attempt_at === null && row.failure_code === null)
    || (row.state === 'retryable' && row.next_attempt_at !== null
      && row.failure_code !== null && retryableFailures.has(row.failure_code))
    || (row.state === 'succeeded' && row.next_attempt_at === null && row.failure_code === null)
    || (row.state === 'conflict' && row.next_attempt_at === null
      && row.failure_code === 'revision_conflict')
    || (row.state === 'reconciled' && row.next_attempt_at === null && row.failure_code === null)
    || (row.state === 'terminal' && row.next_attempt_at === null
      && row.failure_code !== null && terminalFailures.has(row.failure_code));
  if (!validStateTruth) throw new Error('meeting_tag_outbox_v19_invalid_state_truth');
  const request = decodeMeetingTagMutationRequest(parseJson(
    row.request_json,
    'meeting_tag_outbox_v19_invalid_request_json',
  ));
  if (canonicalMeetingTagMutationRequestJson(request) !== row.request_json) {
    throw new Error('meeting_tag_outbox_v19_noncanonical_request');
  }
  const identity = requestIdentity(request);
  if (row.idempotency_key !== request.idempotency_key
    || row.operation_kind !== identity.operationKind
    || row.meeting_id !== identity.meetingId
    || row.source_key !== identity.sourceKey
    || row.tag_id !== identity.tagId) {
    throw new Error('meeting_tag_outbox_v19_identity_mismatch');
  }
  const subjectKey = meetingTagMutationSubjectKey(request);
  if (hasSubject && row.subject_key !== subjectKey) {
    throw new Error('meeting_tag_outbox_v19_subject_mismatch');
  }
  let reconciliationJson: string | null = null;
  if (row.state === 'reconciled') {
    if (!hasReconciliation || typeof row.reconciliation_json !== 'string') {
      throw new Error('meeting_tag_outbox_v19_reconciliation_missing');
    }
    reconciliationJson = canonicalReconciliationJson(
      request,
      parseJson(row.reconciliation_json, 'meeting_tag_outbox_v19_invalid_reconciliation_json'),
    );
    if (reconciliationJson !== row.reconciliation_json) {
      throw new Error('meeting_tag_outbox_v19_noncanonical_reconciliation');
    }
  } else if (hasReconciliation && row.reconciliation_json != null) {
    throw new Error('meeting_tag_outbox_v19_unexpected_reconciliation');
  }
  if (row.state === 'succeeded') {
    if (typeof row.receipt_json !== 'string') throw new Error('meeting_tag_outbox_v19_receipt_missing');
    const receipt = decodeMeetingTagMutationReceipt(
      parseJson(row.receipt_json, 'meeting_tag_outbox_v19_invalid_receipt_json'),
      request,
    );
    if (canonicalMeetingTagMutationReceiptJson(receipt, request) !== row.receipt_json) {
      throw new Error('meeting_tag_outbox_v19_noncanonical_receipt');
    }
  } else if (row.receipt_json !== null) {
    throw new Error('meeting_tag_outbox_v19_unexpected_receipt');
  }
  return { ...row, subject_key: subjectKey, reconciliation_json: reconciliationJson };
}

/** Rebuild v18 without changing rowids, then install the final constraints. */
export async function migrateMeetingTagOutboxV19(db: MigrationDb): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(meeting_tag_outbox);');
  if (columns.length === 0) throw new Error('meeting_tag_outbox_v19_source_missing');
  const columnNames = new Set(columns.map((column) => column.name));
  const hasSubject = columnNames.has('subject_key');
  const hasReconciliation = columnNames.has('reconciliation_json');
  const legacyRows = await db.getAllAsync<LegacyOutboxRow>(
    'SELECT rowid AS source_rowid, * FROM meeting_tag_outbox ORDER BY rowid ASC;',
  );
  const preparedRows = legacyRows.map((row) => prepareLegacyRow(row, hasSubject, hasReconciliation));
  const unresolvedSubjects = new Set<string>();
  for (const row of preparedRows) {
    if (!['queued', 'running', 'retryable', 'conflict'].includes(row.state)) continue;
    const key = JSON.stringify([row.owner_user_id, row.subject_key]);
    if (unresolvedSubjects.has(key)) throw new Error('meeting_tag_outbox_v19_duplicate_unresolved_subject');
    unresolvedSubjects.add(key);
  }

  await db.execAsync(`DROP TRIGGER IF EXISTS meeting_tag_outbox_immutable_request;
DROP TRIGGER IF EXISTS meeting_tag_outbox_state_transition;
DROP INDEX IF EXISTS idx_meeting_tag_outbox_owner_due;
DROP INDEX IF EXISTS idx_meeting_tag_outbox_subject;
ALTER TABLE meeting_tag_outbox RENAME TO meeting_tag_outbox_v18_backup;
${MEETING_TAG_OUTBOX_V19_TABLE_SQL}`);
  for (const row of preparedRows) {
    await db.runAsync(
      `INSERT INTO meeting_tag_outbox
        (rowid, idempotency_key, owner_user_id, request_json, operation_kind,
         meeting_id, source_key, tag_id, subject_key, state, attempt_count,
         next_attempt_at, lease_token, lease_until, receipt_json, reconciliation_json,
         failure_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.source_rowid,
        row.idempotency_key,
        row.owner_user_id,
        row.request_json,
        row.operation_kind,
        row.meeting_id,
        row.source_key,
        row.tag_id,
        row.subject_key,
        row.state,
        row.attempt_count,
        row.next_attempt_at,
        row.lease_token,
        row.lease_until,
        row.receipt_json,
        row.reconciliation_json,
        row.failure_code,
        row.created_at,
        row.updated_at,
      ],
    );
  }
  await db.execAsync(`DROP TABLE meeting_tag_outbox_v18_backup;
${MEETING_TAG_OUTBOX_V19_FINALIZE_SQL}`);
}
