import type * as SQLite from 'expo-sqlite';

import type {
  MeetingTagMutationReceiptV1,
  MeetingTagMutationRequestV1,
} from '@/contracts/mkc-meeting-tags.generated';
import {
  canonicalMeetingTagMutationRequestJson,
  canonicalizeMeetingTagMutationRequest,
  decodeMeetingTagMutationReceipt,
  decodeMeetingTagMutationRequest,
} from '@/services/mkc-meeting-tags-core';
import { withDurableWakeTransaction } from './db';

export type MeetingTagOutboxState =
  | 'queued'
  | 'running'
  | 'retryable'
  | 'succeeded'
  | 'conflict'
  | 'terminal';

export type MeetingTagOutboxFailureCode =
  | 'offline'
  | 'transport_retryable'
  | 'http_retryable'
  | 'revision_conflict'
  | 'auth_required'
  | 'validation_rejected'
  | 'protocol_rejected';

export type MeetingTagOutboxErrorReason =
  | 'invalid_owner'
  | 'invalid_clock'
  | 'invalid_lease'
  | 'invalid_record'
  | 'idempotency_conflict'
  | 'pending_subject'
  | 'canonical_refresh_required'
  | 'claim_lost';

export class MeetingTagOutboxError extends Error {
  constructor(readonly reason: MeetingTagOutboxErrorReason) {
    super(`Meeting-tag outbox rejected: ${reason}`);
    this.name = 'MeetingTagOutboxError';
  }
}

type MeetingTagOperationKind = MeetingTagMutationRequestV1['operation']['kind'];

interface MeetingTagOutboxRow {
  idempotency_key: string;
  owner_user_id: string;
  request_json: string;
  operation_kind: MeetingTagOperationKind;
  meeting_id: string | null;
  source_key: string | null;
  tag_id: string | null;
  state: MeetingTagOutboxState;
  attempt_count: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  receipt_json: string | null;
  failure_code: MeetingTagOutboxFailureCode | null;
  created_at: number;
  updated_at: number;
}

export interface MeetingTagOutboxEntry {
  idempotencyKey: string;
  ownerUserId: string;
  request: MeetingTagMutationRequestV1;
  state: MeetingTagOutboxState;
  attemptCount: number;
  nextAttemptAt: number | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  receipt: MeetingTagMutationReceiptV1 | null;
  failureCode: MeetingTagOutboxFailureCode | null;
  createdAt: number;
  updatedAt: number;
}

type MeetingTagTransaction = Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'runAsync'>;

const states = new Set<MeetingTagOutboxState>([
  'queued', 'running', 'retryable', 'succeeded', 'conflict', 'terminal',
]);
const failureCodes = new Set<MeetingTagOutboxFailureCode>([
  'offline',
  'transport_retryable',
  'http_retryable',
  'revision_conflict',
  'auth_required',
  'validation_rejected',
  'protocol_rejected',
]);
const unresolvedStates = new Set<MeetingTagOutboxState>([
  'queued', 'running', 'retryable', 'conflict',
]);
const leaseTokenPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

function reject(reason: MeetingTagOutboxErrorReason): never {
  throw new MeetingTagOutboxError(reason);
}

function isOwner(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && value.trim() === value;
}

function assertOwner(value: string): string {
  if (!isOwner(value)) reject('invalid_owner');
  return value;
}

function assertClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) reject('invalid_clock');
  return value;
}

function assertLease(value: string): string {
  if (!leaseTokenPattern.test(value)) reject('invalid_lease');
  return value;
}

function identityFor(request: MeetingTagMutationRequestV1): {
  operationKind: MeetingTagOperationKind;
  meetingId: string | null;
  sourceKey: string | null;
  tagId: string | null;
} {
  const operation = request.operation;
  return {
    operationKind: operation.kind,
    meetingId: 'meeting_id' in operation ? operation.meeting_id : null,
    sourceKey: 'source_key' in operation ? operation.source_key : null,
    tagId: 'tag_id' in operation ? operation.tag_id : null,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    reject('invalid_record');
  }
}

function decodeRow(row: MeetingTagOutboxRow): MeetingTagOutboxEntry {
  if (!isOwner(row.owner_user_id) || !states.has(row.state)
    || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0
    || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at
    || (row.next_attempt_at !== null
      && (!Number.isSafeInteger(row.next_attempt_at) || row.next_attempt_at < 0))
    || (row.failure_code !== null && !failureCodes.has(row.failure_code))) {
    reject('invalid_record');
  }
  const request = decodeMeetingTagMutationRequest(parseJson(row.request_json));
  if (canonicalMeetingTagMutationRequestJson(request) !== row.request_json) reject('invalid_record');
  const identity = identityFor(request);
  if (row.idempotency_key !== request.idempotency_key
    || row.operation_kind !== identity.operationKind
    || row.meeting_id !== identity.meetingId
    || row.source_key !== identity.sourceKey
    || row.tag_id !== identity.tagId) {
    reject('invalid_record');
  }
  if (row.state === 'running') {
    if (row.lease_token === null || row.lease_until === null
      || !leaseTokenPattern.test(row.lease_token)
      || !Number.isSafeInteger(row.lease_until) || row.lease_until < 0) reject('invalid_record');
  } else if (row.lease_token !== null || row.lease_until !== null) {
    reject('invalid_record');
  }
  if ((row.state === 'queued' || row.state === 'running')
    && (row.failure_code !== null || row.next_attempt_at !== null)) reject('invalid_record');
  if (row.state === 'retryable'
    && (row.failure_code === null || row.next_attempt_at === null)) reject('invalid_record');
  if ((row.state === 'conflict' || row.state === 'terminal')
    && (row.failure_code === null || row.next_attempt_at !== null)) reject('invalid_record');
  if (row.state === 'succeeded' && row.next_attempt_at !== null) reject('invalid_record');
  let receipt: MeetingTagMutationReceiptV1 | null = null;
  if (row.state === 'succeeded') {
    if (row.receipt_json === null || row.failure_code !== null) reject('invalid_record');
    receipt = decodeMeetingTagMutationReceipt(parseJson(row.receipt_json), request);
  } else if (row.receipt_json !== null) {
    reject('invalid_record');
  }
  return {
    idempotencyKey: row.idempotency_key,
    ownerUserId: row.owner_user_id,
    request,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    receipt,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function canonicalReceiptJson(receipt: MeetingTagMutationReceiptV1): string {
  return JSON.stringify(receipt, Object.keys(receipt).sort());
}

async function findByKey(
  transaction: MeetingTagTransaction,
  idempotencyKey: string,
): Promise<MeetingTagOutboxRow | null> {
  return transaction.getFirstAsync<MeetingTagOutboxRow>(
    'SELECT * FROM meeting_tag_outbox WHERE idempotency_key = ?',
    [idempotencyKey],
  );
}

export async function enqueueMeetingTagMutationInTransaction(
  transaction: MeetingTagTransaction,
  input: { ownerUserId: string; request: unknown; now: number },
): Promise<MeetingTagOutboxEntry> {
  const ownerUserId = assertOwner(input.ownerUserId);
  const now = assertClock(input.now);
  const request = canonicalizeMeetingTagMutationRequest(input.request);
  const requestJson = canonicalMeetingTagMutationRequestJson(request);
  const identity = identityFor(request);
  const priorKey = await findByKey(transaction, request.idempotency_key);
  if (priorKey) {
    if (priorKey.owner_user_id !== ownerUserId || priorKey.request_json !== requestJson) {
      reject('idempotency_conflict');
    }
    return decodeRow(priorKey);
  }

  if (identity.tagId !== null) {
    const unresolved = await transaction.getFirstAsync<MeetingTagOutboxRow>(
      `SELECT * FROM meeting_tag_outbox
       WHERE owner_user_id = ? AND tag_id = ?
         AND ((meeting_id IS NULL AND ? IS NULL) OR meeting_id = ?)
         AND state IN ('queued', 'running', 'retryable', 'conflict')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [ownerUserId, identity.tagId, identity.meetingId, identity.meetingId],
    );
    if (unresolved && unresolvedStates.has(decodeRow(unresolved).state)) reject('pending_subject');
  }

  if (request.operation.kind === 'assign') {
    const latestSuccess = await transaction.getFirstAsync<MeetingTagOutboxRow>(
      `SELECT * FROM meeting_tag_outbox
       WHERE owner_user_id = ? AND meeting_id = ? AND tag_id = ? AND state = 'succeeded'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [ownerUserId, request.operation.meeting_id, request.operation.tag_id],
    );
    if (latestSuccess) {
      const latest = decodeRow(latestSuccess);
      if (latest.request.operation.kind === 'remove') {
        if (!latest.receipt
          || request.operation.expected_meeting_revision !== latest.receipt.meeting_revision
          || request.operation.expected_assignment_revision !== latest.receipt.assignment_revision) {
          reject('canonical_refresh_required');
        }
      }
    }
  }

  await transaction.runAsync(
    `INSERT INTO meeting_tag_outbox
      (idempotency_key, owner_user_id, request_json, operation_kind, meeting_id,
       source_key, tag_id, state, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    [
      request.idempotency_key,
      ownerUserId,
      requestJson,
      identity.operationKind,
      identity.meetingId,
      identity.sourceKey,
      identity.tagId,
      now,
      now,
    ],
  );
  const inserted = await findByKey(transaction, request.idempotency_key);
  if (!inserted) reject('invalid_record');
  return decodeRow(inserted);
}

export async function enqueueMeetingTagMutation(input: {
  ownerUserId: string;
  request: unknown;
  now?: number;
}): Promise<MeetingTagOutboxEntry> {
  const now = input.now ?? Date.now();
  return withDurableWakeTransaction((transaction) => (
    enqueueMeetingTagMutationInTransaction(transaction, { ...input, now })
  ));
}

export async function claimNextMeetingTagMutationInTransaction(
  transaction: MeetingTagTransaction,
  input: { ownerUserId: string; leaseToken: string; now: number; leaseMs: number },
): Promise<MeetingTagOutboxEntry | null> {
  const ownerUserId = assertOwner(input.ownerUserId);
  const leaseToken = assertLease(input.leaseToken);
  const now = assertClock(input.now);
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1_000 || input.leaseMs > 600_000) {
    reject('invalid_lease');
  }
  const leaseUntil = now + input.leaseMs;
  if (!Number.isSafeInteger(leaseUntil)) reject('invalid_clock');
  const candidate = await transaction.getFirstAsync<MeetingTagOutboxRow>(
    `SELECT * FROM meeting_tag_outbox
     WHERE owner_user_id = ? AND (
       state = 'queued'
       OR (state = 'retryable' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
       OR (state = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
     )
     ORDER BY created_at ASC, rowid ASC LIMIT 1`,
    [ownerUserId, now, now],
  );
  if (!candidate) return null;
  decodeRow(candidate);
  if (now < candidate.updated_at) reject('invalid_clock');
  const result = await transaction.runAsync(
    `UPDATE meeting_tag_outbox
     SET state = 'running', attempt_count = attempt_count + 1,
       next_attempt_at = NULL, lease_token = ?, lease_until = ?,
       failure_code = NULL, updated_at = ?
     WHERE idempotency_key = ? AND owner_user_id = ? AND state = ? AND updated_at = ?`,
    [
      leaseToken,
      leaseUntil,
      now,
      candidate.idempotency_key,
      ownerUserId,
      candidate.state,
      candidate.updated_at,
    ],
  );
  if (result.changes !== 1) reject('claim_lost');
  const claimed = await findByKey(transaction, candidate.idempotency_key);
  if (!claimed) reject('invalid_record');
  return decodeRow(claimed);
}

export async function claimNextMeetingTagMutation(input: {
  ownerUserId: string;
  leaseToken: string;
  now?: number;
  leaseMs?: number;
}): Promise<MeetingTagOutboxEntry | null> {
  const now = input.now ?? Date.now();
  return withDurableWakeTransaction((transaction) => claimNextMeetingTagMutationInTransaction(
    transaction,
    { ...input, now, leaseMs: input.leaseMs ?? 60_000 },
  ));
}

export async function completeMeetingTagMutationInTransaction(
  transaction: MeetingTagTransaction,
  input: {
    ownerUserId: string;
    idempotencyKey: string;
    leaseToken: string;
    receipt: unknown;
    now: number;
  },
): Promise<MeetingTagOutboxEntry> {
  const ownerUserId = assertOwner(input.ownerUserId);
  const leaseToken = assertLease(input.leaseToken);
  const now = assertClock(input.now);
  const row = await findByKey(transaction, input.idempotencyKey);
  if (!row || row.owner_user_id !== ownerUserId
    || row.state !== 'running' || row.lease_token !== leaseToken) reject('claim_lost');
  const entry = decodeRow(row);
  if (now < entry.updatedAt) reject('invalid_clock');
  const receipt = decodeMeetingTagMutationReceipt(input.receipt, entry.request);
  const result = await transaction.runAsync(
    `UPDATE meeting_tag_outbox
     SET state = 'succeeded', receipt_json = ?, failure_code = NULL,
       lease_token = NULL, lease_until = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE idempotency_key = ? AND owner_user_id = ?
       AND state = 'running' AND lease_token = ?`,
    [canonicalReceiptJson(receipt), now, input.idempotencyKey, ownerUserId, leaseToken],
  );
  if (result.changes !== 1) reject('claim_lost');
  const completed = await findByKey(transaction, input.idempotencyKey);
  if (!completed) reject('invalid_record');
  return decodeRow(completed);
}

export async function completeMeetingTagMutation(input: {
  ownerUserId: string;
  idempotencyKey: string;
  leaseToken: string;
  receipt: unknown;
  now?: number;
}): Promise<MeetingTagOutboxEntry> {
  const now = input.now ?? Date.now();
  return withDurableWakeTransaction((transaction) => (
    completeMeetingTagMutationInTransaction(transaction, { ...input, now })
  ));
}

export async function failMeetingTagMutationInTransaction(
  transaction: MeetingTagTransaction,
  input: {
    ownerUserId: string;
    idempotencyKey: string;
    leaseToken: string;
    state: 'retryable' | 'conflict' | 'terminal';
    failureCode: MeetingTagOutboxFailureCode;
    nextAttemptAt?: number | null;
    now: number;
  },
): Promise<MeetingTagOutboxEntry> {
  const ownerUserId = assertOwner(input.ownerUserId);
  const leaseToken = assertLease(input.leaseToken);
  const now = assertClock(input.now);
  if (!failureCodes.has(input.failureCode)) reject('invalid_record');
  const nextAttemptAt = input.state === 'retryable'
    ? assertClock(input.nextAttemptAt ?? -1)
    : null;
  if (nextAttemptAt !== null && nextAttemptAt < now) reject('invalid_clock');
  const allowedFailure = input.state === 'retryable'
    ? new Set<MeetingTagOutboxFailureCode>(['offline', 'transport_retryable', 'http_retryable'])
    : input.state === 'conflict'
      ? new Set<MeetingTagOutboxFailureCode>(['revision_conflict'])
      : new Set<MeetingTagOutboxFailureCode>(['auth_required', 'validation_rejected', 'protocol_rejected']);
  if (!allowedFailure.has(input.failureCode)) reject('invalid_record');
  const row = await findByKey(transaction, input.idempotencyKey);
  if (!row || row.owner_user_id !== ownerUserId
    || row.state !== 'running' || row.lease_token !== leaseToken) reject('claim_lost');
  const entry = decodeRow(row);
  if (now < entry.updatedAt) reject('invalid_clock');
  const result = await transaction.runAsync(
    `UPDATE meeting_tag_outbox
     SET state = ?, failure_code = ?, next_attempt_at = ?,
       lease_token = NULL, lease_until = NULL, updated_at = ?
     WHERE idempotency_key = ? AND owner_user_id = ?
       AND state = 'running' AND lease_token = ?`,
    [
      input.state,
      input.failureCode,
      nextAttemptAt,
      now,
      input.idempotencyKey,
      ownerUserId,
      leaseToken,
    ],
  );
  if (result.changes !== 1) reject('claim_lost');
  const failed = await findByKey(transaction, input.idempotencyKey);
  if (!failed) reject('invalid_record');
  return decodeRow(failed);
}

export async function failMeetingTagMutation(input: {
  ownerUserId: string;
  idempotencyKey: string;
  leaseToken: string;
  state: 'retryable' | 'conflict' | 'terminal';
  failureCode: MeetingTagOutboxFailureCode;
  nextAttemptAt?: number | null;
  now?: number;
}): Promise<MeetingTagOutboxEntry> {
  const now = input.now ?? Date.now();
  return withDurableWakeTransaction((transaction) => (
    failMeetingTagMutationInTransaction(transaction, { ...input, now })
  ));
}
