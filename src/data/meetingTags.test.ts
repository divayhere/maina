import { describe, expect, it, vi } from 'vitest';

import example from '../../contracts/mkc-meeting-tags/maina-meeting-tags.v1.json';
import type { MeetingTagMutationRequestV1 } from '@/contracts/mkc-meeting-tags.generated';
import {
  MEETING_TAG_OUTBOX_V18_MIGRATION_SQL,
  MEETING_TAG_OUTBOX_V19_FINALIZE_SQL,
  MEETING_TAG_OUTBOX_V19_TABLE_SQL,
} from './meetingTagsMigration';
import {
  claimNextMeetingTagMutationInTransaction,
  completeMeetingTagMutationInTransaction,
  countClaimableMeetingTagMutationsInTransaction,
  enqueueMeetingTagMutationInTransaction,
  failMeetingTagMutationInTransaction,
  MeetingTagOutboxError,
  reconcileMeetingTagConflictInTransaction,
} from './meetingTags';

vi.mock('./db', () => ({
  withDurableWakeTransaction: vi.fn(),
}));

type Row = Record<string, unknown> & { idempotency_key: string };

class MemoryMeetingTagTransaction {
  readonly rows = new Map<string, Row>();

  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = [...this.rows.values()];
    if (sql.includes('COUNT(*) AS claimable_count')) {
      const ownerId = String(params[0]);
      const now = Number(params[1]);
      return ({
        claimable_count: rows
          .filter((row) => row.owner_user_id === ownerId)
          .filter((row) => row.state === 'queued'
            || (row.state === 'retryable' && Number(row.next_attempt_at) <= now)
            || (row.state === 'running' && Number(row.lease_until) <= now))
          .length,
      } as T);
    }
    if (sql.includes('WHERE idempotency_key = ?')) {
      return (this.rows.get(String(params[0])) ?? null) as T | null;
    }
    if (sql.includes("state IN ('queued', 'running', 'retryable', 'conflict')")) {
      const [owner, subject] = params;
      return (rows
        .filter((row) => row.owner_user_id === owner && row.subject_key === subject)
        .filter((row) => ['queued', 'running', 'retryable', 'conflict'].includes(String(row.state)))
        .sort(newestFirst)[0] ?? null) as T | null;
    }
    if (sql.includes("state = 'succeeded'")) {
      const [owner, meeting, tag] = params;
      return (rows
        .filter((row) => row.owner_user_id === owner
          && row.meeting_id === meeting && row.tag_id === tag && row.state === 'succeeded')
        .sort(newestFirst)[0] ?? null) as T | null;
    }
    if (sql.includes("state IN ('succeeded', 'reconciled')")) {
      const [owner, subject] = params;
      return (rows
        .filter((row) => row.owner_user_id === owner && row.subject_key === subject)
        .filter((row) => row.state === 'succeeded' || row.state === 'reconciled')
        .sort(newestFirst)[0] ?? null) as T | null;
    }
    if (sql.includes("state = 'queued'")) {
      const ownerId = String(params[0]);
      const now = Number(params[1]);
      return (rows
        .filter((row) => row.owner_user_id === ownerId)
        .filter((row) => row.state === 'queued'
          || (row.state === 'retryable' && Number(row.next_attempt_at) <= now)
          || (row.state === 'running' && Number(row.lease_until) <= now))
        .sort(oldestFirst)[0] ?? null) as T | null;
    }
    throw new Error(`Unexpected SELECT: ${sql}`);
  }

  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    if (sql.includes('INSERT INTO meeting_tag_outbox')) {
      const [key, owner, requestJson, operation, meeting, source, tag, subject, created, updated] = params;
      this.rows.set(String(key), {
        source_rowid: this.rows.size + 1,
        idempotency_key: String(key),
        owner_user_id: owner,
        request_json: requestJson,
        operation_kind: operation,
        meeting_id: meeting,
        source_key: source,
        tag_id: tag,
        subject_key: subject,
        state: 'queued',
        attempt_count: 0,
        next_attempt_at: null,
        lease_token: null,
        lease_until: null,
        receipt_json: null,
        reconciliation_json: null,
        failure_code: null,
        created_at: created,
        updated_at: updated,
      });
      return { changes: 1 };
    }
    if (sql.includes("SET state = 'running'")) {
      const [leaseToken, leaseUntil, now, key, owner, expectedState, expectedUpdated] = params;
      const row = this.rows.get(String(key));
      if (!row || row.owner_user_id !== owner || row.state !== expectedState
        || row.updated_at !== expectedUpdated) return { changes: 0 };
      Object.assign(row, {
        state: 'running',
        attempt_count: Number(row.attempt_count) + 1,
        next_attempt_at: null,
        lease_token: leaseToken,
        lease_until: leaseUntil,
        failure_code: null,
        updated_at: now,
      });
      return { changes: 1 };
    }
    if (sql.includes("SET state = 'succeeded'")) {
      const [receiptJson, now, key, owner, leaseToken] = params;
      const row = this.rows.get(String(key));
      if (!row || row.owner_user_id !== owner || row.state !== 'running'
        || row.lease_token !== leaseToken) return { changes: 0 };
      Object.assign(row, {
        state: 'succeeded',
        receipt_json: receiptJson,
        failure_code: null,
        lease_token: null,
        lease_until: null,
        next_attempt_at: null,
        updated_at: now,
      });
      return { changes: 1 };
    }
    if (sql.includes("SET state = 'reconciled'")) {
      const [reconciliationJson, now, key, owner] = params;
      const row = this.rows.get(String(key));
      if (!row || row.owner_user_id !== owner || row.state !== 'conflict'
        || row.failure_code !== 'revision_conflict') return { changes: 0 };
      Object.assign(row, {
        state: 'reconciled',
        reconciliation_json: reconciliationJson,
        failure_code: null,
        updated_at: now,
      });
      return { changes: 1 };
    }
    if (sql.includes('SET state = ?, failure_code = ?')) {
      const [state, failure, nextAttempt, now, key, owner, leaseToken] = params;
      const row = this.rows.get(String(key));
      if (!row || row.owner_user_id !== owner || row.state !== 'running'
        || row.lease_token !== leaseToken) return { changes: 0 };
      Object.assign(row, {
        state,
        failure_code: failure,
        next_attempt_at: nextAttempt,
        lease_token: null,
        lease_until: null,
        updated_at: now,
      });
      return { changes: 1 };
    }
    throw new Error(`Unexpected mutation: ${sql}`);
  }
}

function newestFirst(left: Row, right: Row): number {
  return Number(right.source_rowid) - Number(left.source_rowid);
}

function oldestFirst(left: Row, right: Row): number {
  return Number(left.source_rowid) - Number(right.source_rowid);
}

const owner = 'owner:mobile:test';
const transaction = (memory: MemoryMeetingTagTransaction) => memory as never;

function requestWithKey(
  key: string,
  operation: MeetingTagMutationRequestV1['operation'] = example.remove_request.operation as MeetingTagMutationRequestV1['operation'],
) {
  return {
    schema_version: 'mkc.meeting-tag-mutation-request.v1',
    idempotency_key: key,
    operation,
  };
}

async function enqueueRemove(memory: MemoryMeetingTagTransaction, key: string, now = 100) {
  return enqueueMeetingTagMutationInTransaction(transaction(memory), {
    ownerUserId: owner,
    request: requestWithKey(key),
    now,
  });
}

describe('meeting-tag durable outbox', () => {
  it('appends one immutable owner-bound outbox migration to maina.db', () => {
    expect(MEETING_TAG_OUTBOX_V18_MIGRATION_SQL).toContain('CREATE TABLE IF NOT EXISTS meeting_tag_outbox');
    expect(MEETING_TAG_OUTBOX_V18_MIGRATION_SQL).not.toContain('subject_key');
    expect(MEETING_TAG_OUTBOX_V18_MIGRATION_SQL).not.toContain('reconciliation_json');
    expect(MEETING_TAG_OUTBOX_V19_TABLE_SQL).toContain('subject_key TEXT NOT NULL');
    expect(MEETING_TAG_OUTBOX_V19_TABLE_SQL).toContain('reconciliation_json TEXT');
    expect(MEETING_TAG_OUTBOX_V19_FINALIZE_SQL)
      .toContain("RAISE(ABORT, 'meeting_tag_outbox_identity_immutable')");
    expect(MEETING_TAG_OUTBOX_V19_FINALIZE_SQL)
      .toContain("RAISE(ABORT, 'meeting_tag_outbox_state_transition_invalid')");
    expect(MEETING_TAG_OUTBOX_V19_TABLE_SQL)
      .toContain("'queued', 'running', 'retryable', 'succeeded', 'conflict', 'reconciled', 'terminal'");
    expect(MEETING_TAG_OUTBOX_V19_TABLE_SQL).toContain('owner_user_id TEXT NOT NULL');
  });

  it('coalesces a canonical same-key replay and rejects body or owner drift', async () => {
    const memory = new MemoryMeetingTagTransaction();
    const create = requestWithKey('mobile-outbox:create:1000', {
      kind: 'create_definition',
      display_label: ' Customer  Research ',
    });
    const first = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: create,
      now: 100,
    });
    expect(first.request.operation).toEqual({
      kind: 'create_definition',
      display_label: 'Customer Research',
    });
    const replay = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:1000', {
        kind: 'create_definition',
        display_label: 'Customer Research',
      }),
      now: 101,
    });
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect(memory.rows.size).toBe(1);
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:1000', {
        kind: 'create_definition',
        display_label: 'Pricing',
      }),
      now: 102,
    })).rejects.toMatchObject({ reason: 'idempotency_conflict' } satisfies Partial<MeetingTagOutboxError>);
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: 'owner:other',
      request: create,
      now: 103,
    })).rejects.toMatchObject({ reason: 'idempotency_conflict' } satisfies Partial<MeetingTagOutboxError>);
  });

  it('serializes one meeting/tag subject until its prior operation is resolved', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, 'mobile-outbox:remove:1000');
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:remove:1001', {
        ...example.remove_request.operation,
        kind: 'remove',
        expected_meeting_revision: 10,
        expected_assignment_revision: 2,
      }),
      now: 101,
    })).rejects.toMatchObject({ reason: 'pending_subject' } satisfies Partial<MeetingTagOutboxError>);
  });

  it('serializes equivalent create labels while allowing distinct owner-scoped labels', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:equivalent-1', {
        kind: 'create_definition',
        display_label: ' Dubai ',
      }),
      now: 100,
    });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:equivalent-2', {
        kind: 'create_definition',
        display_label: 'ＤＵＢＡＩ',
      }),
      now: 101,
    })).rejects.toMatchObject({ reason: 'pending_subject' } satisfies Partial<MeetingTagOutboxError>);
    const distinct = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:distinct', {
        kind: 'create_definition',
        display_label: 'Customer Research',
      }),
      now: 102,
    });
    expect(distinct).toMatchObject({ state: 'queued' });
    const otherOwner = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: 'owner:other',
      request: requestWithKey('mobile-outbox:create:other-owner', {
        kind: 'create_definition',
        display_label: 'ＤＵＢＡＩ',
      }),
      now: 103,
    });
    expect(otherOwner.ownerUserId).toBe('owner:other');
    expect(memory.rows.size).toBe(3);
  });

  it('prevents an offline remove tombstone from being resurrected with stale revisions', async () => {
    const staleMemory = new MemoryMeetingTagTransaction();
    await enqueueRemove(staleMemory, example.remove_request.idempotency_key);
    await claimNextMeetingTagMutationInTransaction(transaction(staleMemory), {
      ownerUserId: owner,
      leaseToken: 'lease:remove:1',
      now: 110,
      leaseMs: 60_000,
    });
    await completeMeetingTagMutationInTransaction(transaction(staleMemory), {
      ownerUserId: owner,
      idempotencyKey: example.remove_request.idempotency_key,
      leaseToken: 'lease:remove:1',
      receipt: example.remove_receipt,
      now: 120,
    });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(staleMemory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:assign:stale', {
        kind: 'assign',
        meeting_id: example.remove_request.operation.meeting_id,
        source_key: example.remove_request.operation.source_key,
        tag_id: example.remove_request.operation.tag_id,
        expected_meeting_revision: 9,
        expected_assignment_revision: 1,
      }),
      now: 130,
    })).rejects.toMatchObject({
      reason: 'canonical_refresh_required',
    } satisfies Partial<MeetingTagOutboxError>);

    const fresh = await enqueueMeetingTagMutationInTransaction(transaction(staleMemory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:assign:fresh', {
        kind: 'assign',
        meeting_id: example.remove_request.operation.meeting_id,
        source_key: example.remove_request.operation.source_key,
        tag_id: example.remove_request.operation.tag_id,
        expected_meeting_revision: 10,
        expected_assignment_revision: 2,
      }),
      now: 131,
    });
    expect(fresh.state).toBe('queued');
  });

  it('grants one lease, refuses a duplicate claim, and reclaims only after expiry', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, 'mobile-outbox:remove:claim');
    const first = await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:first',
      now: 110,
      leaseMs: 1_000,
    });
    expect(first).toMatchObject({ state: 'running', attemptCount: 1, leaseToken: 'lease:first' });
    expect(await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:early',
      now: 1_109,
      leaseMs: 1_000,
    })).toBeNull();
    const reclaimed = await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:second',
      now: 1_110,
      leaseMs: 1_000,
    });
    expect(reclaimed).toMatchObject({ state: 'running', attemptCount: 2, leaseToken: 'lease:second' });
  });

  it('snapshots only rows claimable for the exact owner and due time', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, 'mobile-outbox:remove:due');
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: 'owner:other',
      request: requestWithKey('mobile-outbox:remove:other'),
      now: 101,
    });
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:future', {
        kind: 'create_definition',
        display_label: 'Future',
      }),
      now: 102,
    });
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:future',
      now: 103,
      leaseMs: 1_000,
    });
    await failMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: 'mobile-outbox:remove:due',
      leaseToken: 'lease:future',
      state: 'retryable',
      failureCode: 'offline',
      nextAttemptAt: 2_000,
      now: 104,
    });
    expect(await countClaimableMeetingTagMutationsInTransaction(transaction(memory), {
      ownerUserId: owner,
      now: 1_999,
    })).toBe(1);
    expect(await countClaimableMeetingTagMutationsInTransaction(transaction(memory), {
      ownerUserId: owner,
      now: 2_000,
    })).toBe(2);
  });

  it('validates the exact request-bound receipt before committing success', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, example.remove_request.idempotency_key);
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:receipt',
      now: 110,
      leaseMs: 60_000,
    });
    await expect(completeMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: example.remove_request.idempotency_key,
      leaseToken: 'lease:receipt',
      receipt: { ...example.remove_receipt, assignment_revision: 1 },
      now: 120,
    })).rejects.toThrow(/assignment revision transition mismatch/);
    expect(memory.rows.get(example.remove_request.idempotency_key)?.state).toBe('running');
    const complete = await completeMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: example.remove_request.idempotency_key,
      leaseToken: 'lease:receipt',
      receipt: example.remove_receipt,
      now: 121,
    });
    expect(complete).toMatchObject({ state: 'succeeded', failureCode: null });
    expect(complete.receipt).toEqual(example.remove_receipt);
  });

  it('persists bounded retry truth and makes it due only at its exact time', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, 'mobile-outbox:remove:retry');
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:retry',
      now: 110,
      leaseMs: 60_000,
    });
    const retryable = await failMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: 'mobile-outbox:remove:retry',
      leaseToken: 'lease:retry',
      state: 'retryable',
      failureCode: 'offline',
      nextAttemptAt: 500,
      now: 120,
    });
    expect(retryable).toMatchObject({
      state: 'retryable',
      failureCode: 'offline',
      nextAttemptAt: 500,
    });
    expect(await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:too-early',
      now: 499,
      leaseMs: 1_000,
    })).toBeNull();
    expect(await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:due',
      now: 500,
      leaseMs: 1_000,
    })).toMatchObject({ state: 'running', attemptCount: 2 });
  });

  it('rejects a failure code that contradicts its durable terminal class', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, 'mobile-outbox:remove:failure-class');
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:failure-class',
      now: 110,
      leaseMs: 60_000,
    });
    await expect(failMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: 'mobile-outbox:remove:failure-class',
      leaseToken: 'lease:failure-class',
      state: 'terminal',
      failureCode: 'http_retryable',
      now: 120,
    })).rejects.toMatchObject({ reason: 'invalid_record' } satisfies Partial<MeetingTagOutboxError>);
    expect(memory.rows.get('mobile-outbox:remove:failure-class')?.state).toBe('running');
  });

  it('keeps a conflict blocking until an exact canonical meeting refresh is durable', async () => {
    const memory = new MemoryMeetingTagTransaction();
    const key = 'mobile-outbox:remove:conflict';
    await enqueueRemove(memory, key);
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:conflict',
      now: 110,
      leaseMs: 60_000,
    });
    await failMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      leaseToken: 'lease:conflict',
      state: 'conflict',
      failureCode: 'revision_conflict',
      now: 120,
    });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:remove:blocked', {
        ...example.remove_request.operation,
        kind: 'remove',
      }),
      now: 121,
    })).rejects.toMatchObject({ reason: 'pending_subject' } satisfies Partial<MeetingTagOutboxError>);
    await expect(reconcileMeetingTagConflictInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      canonicalState: example.meeting_tag_state,
      now: 122,
    })).rejects.toMatchObject({
      reason: 'canonical_refresh_required',
    } satisfies Partial<MeetingTagOutboxError>);

    const refreshedState = {
      ...example.meeting_tag_state,
      meeting_revision: 10,
      active: example.meeting_tag_state.active.map((tag) => (
        tag.tag_id === example.remove_request.operation.tag_id
          ? { ...tag, assignment_revision: 2 }
          : tag
      )),
    };
    const reconciled = await reconcileMeetingTagConflictInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      canonicalState: refreshedState,
      now: 123,
    });
    expect(reconciled).toMatchObject({
      state: 'reconciled',
      failureCode: null,
      reconciliation: { meeting_revision: 10 },
    });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:remove:stale-after-refresh', {
        ...example.remove_request.operation,
        kind: 'remove',
      }),
      now: 124,
    })).rejects.toMatchObject({
      reason: 'canonical_refresh_required',
    } satisfies Partial<MeetingTagOutboxError>);
    const fresh = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:remove:fresh-after-refresh', {
        ...example.remove_request.operation,
        kind: 'remove',
        expected_meeting_revision: 10,
        expected_assignment_revision: 2,
      }),
      now: 125,
    });
    expect(fresh.state).toBe('queued');
  });

  it('rejects regressing assignment state and assignment movement without a meeting advance', async () => {
    const conflict = async (
      key: string,
      expectedAssignmentRevision: number,
      canonicalState: unknown,
    ) => {
      const memory = new MemoryMeetingTagTransaction();
      await enqueueMeetingTagMutationInTransaction(transaction(memory), {
        ownerUserId: owner,
        request: requestWithKey(key, {
          ...example.remove_request.operation,
          kind: 'remove',
          expected_assignment_revision: expectedAssignmentRevision,
        }),
        now: 100,
      });
      await claimNextMeetingTagMutationInTransaction(transaction(memory), {
        ownerUserId: owner,
        leaseToken: `lease:${expectedAssignmentRevision}`,
        now: 110,
        leaseMs: 60_000,
      });
      await failMeetingTagMutationInTransaction(transaction(memory), {
        ownerUserId: owner,
        idempotencyKey: key,
        leaseToken: `lease:${expectedAssignmentRevision}`,
        state: 'conflict',
        failureCode: 'revision_conflict',
        now: 120,
      });
      return reconcileMeetingTagConflictInTransaction(transaction(memory), {
        ownerUserId: owner,
        idempotencyKey: key,
        canonicalState,
        now: 121,
      });
    };
    await expect(conflict(
      'mobile-outbox:remove:lower-assignment',
      2,
      example.meeting_tag_state,
    )).rejects.toMatchObject({ reason: 'canonical_refresh_required' } satisfies Partial<MeetingTagOutboxError>);
    await expect(conflict(
      'mobile-outbox:remove:assignment-without-meeting',
      1,
      {
        ...example.meeting_tag_state,
        active: example.meeting_tag_state.active.map((tag) => (
          tag.tag_id === example.remove_request.operation.tag_id
            ? { ...tag, assignment_revision: 2 }
            : tag
        )),
      },
    )).rejects.toMatchObject({ reason: 'canonical_refresh_required' } satisfies Partial<MeetingTagOutboxError>);
  });

  it('reconciles a create conflict to its canonical namespace owner and forbids duplicate recreation', async () => {
    const memory = new MemoryMeetingTagTransaction();
    const key = 'mobile-outbox:create:conflict';
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey(key, { kind: 'create_definition', display_label: 'ＤＵＢＡＩ' }),
      now: 100,
    });
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:create-conflict',
      now: 110,
      leaseMs: 60_000,
    });
    await failMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      leaseToken: 'lease:create-conflict',
      state: 'conflict',
      failureCode: 'revision_conflict',
      now: 120,
    });
    const reconciled = await reconcileMeetingTagConflictInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      canonicalState: { schema_version: 'mkc.meeting-tag-definitions.v1', definitions: example.definitions },
      now: 121,
    });
    expect(reconciled).toMatchObject({ state: 'reconciled' });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:duplicate-after-refresh', {
        kind: 'create_definition',
        display_label: 'Dubai',
      }),
      now: 122,
    })).rejects.toMatchObject({
      reason: 'canonical_refresh_required',
    } satisfies Partial<MeetingTagOutboxError>);
  });

  it('does not queue a second create after the first canonical receipt succeeded', async () => {
    const memory = new MemoryMeetingTagTransaction();
    const key = 'mobile-outbox:create:succeeded';
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey(key, { kind: 'create_definition', display_label: 'Planning' }),
      now: 100,
    });
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:create-success',
      now: 110,
      leaseMs: 60_000,
    });
    await completeMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: key,
      leaseToken: 'lease:create-success',
      receipt: {
        schema_version: 'mkc.meeting-tag-mutation-receipt.v1',
        idempotency_key: key,
        replayed: false,
        operation: 'create_definition',
        outcome: 'applied',
        tag_id: example.definitions[0].tag_id,
        meeting_id: null,
        tag_revision: 1,
        meeting_revision: null,
        assignment_revision: null,
        assignment_state: null,
        occurred_at: '2026-09-07T00:00:00.000Z',
      },
      now: 120,
    });
    await expect(enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:create:succeeded-duplicate', {
        kind: 'create_definition',
        display_label: ' Planning ',
      }),
      now: 121,
    })).rejects.toMatchObject({
      reason: 'canonical_refresh_required',
    } satisfies Partial<MeetingTagOutboxError>);
  });

  it('orders successor evidence by durable row sequence across a backward device clock', async () => {
    const memory = new MemoryMeetingTagTransaction();
    await enqueueRemove(memory, example.remove_request.idempotency_key, 1_000);
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:clock-remove',
      now: 1_010,
      leaseMs: 60_000,
    });
    await completeMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: example.remove_request.idempotency_key,
      leaseToken: 'lease:clock-remove',
      receipt: example.remove_receipt,
      now: 1_020,
    });
    const assignKey = 'mobile-outbox:assign:clock-rollback';
    await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey(assignKey, {
        kind: 'assign',
        meeting_id: example.remove_request.operation.meeting_id,
        source_key: example.remove_request.operation.source_key,
        tag_id: example.remove_request.operation.tag_id,
        expected_meeting_revision: 10,
        expected_assignment_revision: 2,
      }),
      now: 500,
    });
    await claimNextMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      leaseToken: 'lease:clock-assign',
      now: 510,
      leaseMs: 60_000,
    });
    await completeMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      idempotencyKey: assignKey,
      leaseToken: 'lease:clock-assign',
      receipt: {
        ...example.remove_receipt,
        idempotency_key: assignKey,
        operation: 'assign',
        meeting_revision: 11,
        assignment_revision: 3,
        assignment_state: 'active',
        occurred_at: '2026-09-07T00:01:00.000Z',
      },
      now: 520,
    });
    const successor = await enqueueMeetingTagMutationInTransaction(transaction(memory), {
      ownerUserId: owner,
      request: requestWithKey('mobile-outbox:remove:after-clock-rollback', {
        ...example.remove_request.operation,
        kind: 'remove',
        expected_meeting_revision: 11,
        expected_assignment_revision: 3,
      }),
      now: 400,
    });
    expect(successor).toMatchObject({ state: 'queued', createdAt: 400 });
  });
});
