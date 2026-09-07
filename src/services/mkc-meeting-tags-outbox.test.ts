/* eslint-disable import/first -- module doubles must be installed before the production import. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import example from '../../contracts/mkc-meeting-tags/maina-meeting-tags.v1.json';

const mocks = vi.hoisted(() => ({
  transaction: { marker: 'transaction' },
  withTransaction: vi.fn(),
  enqueue: vi.fn(),
  count: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  failInTransaction: vi.fn(),
  reconcileClaimed: vi.fn(),
  deferredWake: vi.fn(),
  repairSchedule: vi.fn(),
  requireScope: vi.fn(),
  mutate: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
}));

vi.mock('@/data/db', () => ({
  withDurableWakeTransaction: mocks.withTransaction,
}));
vi.mock('@/data/pipelineWake', () => ({
  persistDeferredPipelineWakeInTransaction: mocks.deferredWake,
}));
vi.mock('@/services/pipelineWakeScheduler', () => ({
  repairDurablePipelineScheduling: mocks.repairSchedule,
}));
vi.mock('@/services/mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error {},
  MainaCloudSessionMismatchError: class MainaCloudSessionMismatchError extends Error {},
  MainaCloudScopeError: class MainaCloudScopeError extends Error {},
  mainaCloudRequestJson: vi.fn(),
  pinMainaCloudExecutionContext: (session: { user: { userId: string }; accessToken: string; scopesVerifiedAt: number }) => ({
    ownerUserId: session.user.userId,
    accessToken: session.accessToken,
    scopesVerifiedAt: session.scopesVerifiedAt,
  }),
  requireMainaCloudScope: mocks.requireScope,
}));
vi.mock('@/services/mkc-memory-flags', () => ({
  MKC_MEMORY_FEATURE_FLAGS: { mobileMeetingTagsV1: false },
}));
vi.mock('@/data/meetingTags', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/data/meetingTags')>(),
  enqueueMeetingTagMutationInTransaction: mocks.enqueue,
  countClaimableMeetingTagMutationsInTransaction: mocks.count,
  claimNextMeetingTagMutationInTransaction: mocks.claim,
  completeMeetingTagMutation: mocks.complete,
  failMeetingTagMutation: mocks.fail,
  failMeetingTagMutationInTransaction: mocks.failInTransaction,
  reconcileClaimedMeetingTagConflictInTransaction: mocks.reconcileClaimed,
}));
vi.mock('@/services/mkc-meeting-tags', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/mkc-meeting-tags')>(),
  mutateMkcMeetingTags: mocks.mutate,
  listMkcMeetingTags: mocks.list,
  readMkcMeetingTagState: mocks.read,
}));

import { MeetingTagOutboxError } from '@/data/meetingTags';
import { MkcMeetingTagsError } from '@/services/mkc-meeting-tags';
import {
  queueMkcMeetingTagMutation,
  reconcilePendingMkcMeetingTagMutations,
} from './mkc-meeting-tags-outbox';

const ownerUserId = 'owner:tags:test';
const executionContext = {
  ownerUserId,
  accessToken: 'owner-token',
  scopesVerifiedAt: 100,
} as const;
const claimed = {
  idempotencyKey: example.remove_request.idempotency_key,
  ownerUserId,
  request: example.remove_request,
  state: 'running',
  attemptCount: 1,
  nextAttemptAt: null,
  leaseToken: 'meeting-tags:test:0',
  leaseUntil: 60_100,
  receipt: null,
  reconciliation: null,
  failureCode: null,
  createdAt: 10,
  updatedAt: 100,
} as const;

function clock(start = 100): () => number {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
}

describe('meeting-tag outbox recovery owner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTransaction.mockImplementation(async (task: (transaction: typeof mocks.transaction) => unknown) => (
      task(mocks.transaction)
    ));
    mocks.requireScope.mockResolvedValue({
      user: { userId: ownerUserId },
      accessToken: executionContext.accessToken,
      scopesVerifiedAt: executionContext.scopesVerifiedAt,
    });
    mocks.count.mockResolvedValue(0);
    mocks.claim.mockResolvedValue(null);
    mocks.complete.mockResolvedValue({});
    mocks.fail.mockResolvedValue({});
    mocks.failInTransaction.mockResolvedValue({});
    mocks.reconcileClaimed.mockResolvedValue({});
    mocks.deferredWake.mockResolvedValue({});
    mocks.repairSchedule.mockResolvedValue({ generation: 1, scheduled: true });
  });

  it('stays default-off before scope, SQLite, scheduling, or transport', async () => {
    await expect(reconcilePendingMkcMeetingTagMutations()).resolves.toMatchObject({
      disposition: 'disabled',
      attempted: 0,
    });
    await expect(queueMkcMeetingTagMutation({ request: example.remove_request }))
      .rejects.toMatchObject({ kind: 'disabled' });
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('does not claim owner work without a verified write scope and does not swallow local faults', async () => {
    const { MainaCloudScopeError } = await import('@/services/mainaCloudSession');
    mocks.requireScope.mockRejectedValueOnce(new MainaCloudScopeError(
      'cloud_scope_unverified',
      'scope unavailable',
    ));
    await expect(reconcilePendingMkcMeetingTagMutations({ enabled: true })).resolves.toMatchObject({
      disposition: 'no_session',
      attempted: 0,
    });
    expect(mocks.withTransaction).not.toHaveBeenCalled();

    mocks.requireScope.mockRejectedValueOnce(new Error('secure-store-failed'));
    await expect(reconcilePendingMkcMeetingTagMutations({ enabled: true }))
      .rejects.toThrow('secure-store-failed');
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('persists an immutable mutation before its immediate durable wake and never sends inline', async () => {
    mocks.enqueue.mockResolvedValue({ ...claimed, state: 'queued', attemptCount: 0, leaseToken: null });
    await queueMkcMeetingTagMutation({ request: example.remove_request, enabled: true, now: 100 });
    expect(mocks.requireScope).toHaveBeenCalledWith('sources:write');
    expect(mocks.enqueue).toHaveBeenCalledWith(mocks.transaction, {
      ownerUserId,
      request: example.remove_request,
      now: 100,
    });
    expect(mocks.deferredWake).toHaveBeenCalledWith(mocks.transaction, {
      notBeforeAt: 100,
      requiresNetwork: true,
      now: 100,
    });
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.deferredWake.mock.invocationCallOrder[0]);
    expect(mocks.repairSchedule).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('snapshots the due budget and makes exactly one mutation attempt for one claimed row', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockResolvedValue(example.remove_receipt);
    const assertActive = vi.fn(async () => undefined);
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      assertActive,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toEqual({
      disposition: 'completed', claimBudget: 1, attempted: 1, succeeded: 1,
      retryable: 0, reconciled: 0, conflicted: 0, terminal: 0,
    });
    expect(mocks.count).toHaveBeenCalledOnce();
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(example.remove_request, {
      enabled: true,
      executionContext,
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: claimed.idempotencyKey,
      leaseToken: claimed.leaseToken,
      receipt: example.remove_receipt,
    }));
    expect(assertActive).toHaveBeenCalledTimes(4);
  });

  it('persists retry state and its future network wake in one transaction without hot retry', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('offline', true, 'sanitized'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(1_000),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ claimBudget: 1, attempted: 1, retryable: 1 });
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.failInTransaction).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({
      state: 'retryable', failureCode: 'offline', nextAttemptAt: 16_003,
    }));
    expect(mocks.deferredWake).toHaveBeenCalledWith(mocks.transaction, {
      notBeforeAt: 16_003,
      requiresNetwork: true,
      now: 1_003,
    });
    expect(mocks.failInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.deferredWake.mock.invocationCallOrder[0]);
    expect(mocks.claim).toHaveBeenCalledOnce();
  });

  it('requeues and stops when the verified owner session changes before transport', async () => {
    mocks.count.mockResolvedValue(2);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError(
      'session_changed',
      true,
      'sanitized',
    ));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(1_000),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ claimBudget: 2, attempted: 1, retryable: 1 });
    expect(mocks.mutate).toHaveBeenCalledWith(claimed.request, {
      enabled: true,
      executionContext,
    });
    expect(mocks.failInTransaction).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({
      state: 'retryable', failureCode: 'transport_retryable',
    }));
    expect(mocks.claim).toHaveBeenCalledOnce();
  });

  it('uses one canonical meeting read after a conflict and durably reconciles before continuing', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockResolvedValue(example.meeting_tag_state);
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ attempted: 1, reconciled: 1 });
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledWith(example.remove_request.operation.source_key, {
      enabled: true,
      executionContext,
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.reconcileClaimed).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({
      canonicalState: example.meeting_tag_state,
      leaseToken: claimed.leaseToken,
    }));
  });

  it('refreshes definition conflicts through the finite definitions endpoint only', async () => {
    const definitionClaim = {
      ...claimed,
      idempotencyKey: 'mobile-outbox:create:conflict',
      request: {
        schema_version: 'mkc.meeting-tag-mutation-request.v1' as const,
        idempotency_key: 'mobile-outbox:create:conflict',
        operation: { kind: 'create_definition' as const, display_label: 'Customer Research' },
      },
    };
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(definitionClaim);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.list.mockResolvedValue({
      schema_version: 'mkc.meeting-tag-definitions.v1',
      definitions: example.definitions,
    });
    await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => definitionClaim.leaseToken,
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ enabled: true, executionContext });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('returns a conflict to retryable when its canonical read is temporarily offline', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockRejectedValue(new MkcMeetingTagsError('retryable', true, 'sanitized'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ attempted: 1, retryable: 1, conflicted: 0 });
    expect(mocks.failInTransaction).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({
      state: 'retryable', failureCode: 'http_retryable',
    }));
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.reconcileClaimed).not.toHaveBeenCalled();
  });

  it('stops the drain if the owner session changes before the 409 refresh request', async () => {
    mocks.count.mockResolvedValue(2);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockRejectedValue(new MkcMeetingTagsError('session_changed', true, 'sanitized'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ claimBudget: 2, attempted: 1, retryable: 1 });
    expect(mocks.read).toHaveBeenCalledWith(example.remove_request.operation.source_key, {
      enabled: true,
      executionContext,
    });
    expect(mocks.failInTransaction).toHaveBeenCalledWith(mocks.transaction, expect.objectContaining({
      state: 'retryable', failureCode: 'transport_retryable',
    }));
    expect(mocks.claim).toHaveBeenCalledOnce();
  });

  it('keeps a verified conflict blocking when canonical refresh is invalid', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockRejectedValue(new MkcMeetingTagsError('protocol', false, 'sanitized'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ attempted: 1, conflicted: 1, terminal: 0 });
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      state: 'conflict', failureCode: 'revision_conflict',
    }));
    expect(mocks.reconcileClaimed).not.toHaveBeenCalled();
  });

  it('keeps pipeline-lease loss outside transport classification and leaves the claim replayable', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockResolvedValue(example.remove_receipt);
    let checks = 0;
    await expect(reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
      assertActive: async () => {
        checks += 1;
        if (checks === 4) throw new Error('pipeline-lease-ended');
      },
    })).rejects.toThrow('pipeline-lease-ended');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.failInTransaction).not.toHaveBeenCalled();
  });

  it('stops after the first auth failure without claiming the remaining budget', async () => {
    mocks.count.mockResolvedValue(2);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('auth', false, 'sanitized'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ claimBudget: 2, attempted: 1, terminal: 1 });
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      state: 'terminal', failureCode: 'auth_required',
    }));
  });

  it('replays the exact immutable request after a later durable retry claim', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValue(claimed);
    mocks.mutate
      .mockRejectedValueOnce(new MkcMeetingTagsError('offline', true, 'sanitized'))
      .mockResolvedValueOnce(example.remove_receipt);
    await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(20_000),
      leaseToken: () => claimed.leaseToken,
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.mutate.mock.calls[0]?.[0]).toBe(claimed.request);
    expect(mocks.mutate.mock.calls[1]?.[0]).toBe(claimed.request);
  });

  it('preserves a conflict when the canonical snapshot is not a valid advance', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockResolvedValue(example.meeting_tag_state);
    mocks.reconcileClaimed.mockRejectedValue(new MeetingTagOutboxError('canonical_refresh_required'));
    const result = await reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    });
    expect(result).toMatchObject({ attempted: 1, conflicted: 1, reconciled: 0 });
    expect(mocks.fail).toHaveBeenCalledOnce();
  });

  it('keeps both valid-conflict transitions inside one transaction and propagates an injected fault', async () => {
    mocks.count.mockResolvedValue(1);
    mocks.claim.mockResolvedValueOnce(claimed);
    mocks.mutate.mockRejectedValue(new MkcMeetingTagsError('conflict', false, 'sanitized'));
    mocks.read.mockResolvedValue(example.meeting_tag_state);
    mocks.reconcileClaimed.mockImplementationOnce(async (transaction: unknown) => {
      expect(transaction).toBe(mocks.transaction);
      throw new Error('fault-between-conflict-transitions');
    });

    await expect(reconcilePendingMkcMeetingTagMutations({
      enabled: true,
      now: clock(),
      leaseToken: () => claimed.leaseToken,
    })).rejects.toThrow('fault-between-conflict-transitions');
    expect(mocks.withTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.fail).not.toHaveBeenCalled();
  });
});
