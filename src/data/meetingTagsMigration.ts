export const MEETING_TAG_OUTBOX_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS meeting_tag_outbox (
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
  ON meeting_tag_outbox(owner_user_id, subject_key, state, created_at DESC);
CREATE TRIGGER IF NOT EXISTS meeting_tag_outbox_immutable_request
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
