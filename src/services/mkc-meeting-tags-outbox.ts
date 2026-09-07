import {
  claimNextMeetingTagMutationInTransaction,
  completeMeetingTagMutation,
  countClaimableMeetingTagMutationsInTransaction,
  enqueueMeetingTagMutationInTransaction,
  failMeetingTagMutation,
  failMeetingTagMutationInTransaction,
  MeetingTagOutboxError,
  reconcileClaimedMeetingTagConflictInTransaction,
  type MeetingTagOutboxEntry,
  type MeetingTagOutboxFailureCode,
} from '@/data/meetingTags';
import { withDurableWakeTransaction } from '@/data/db';
import { persistDeferredPipelineWakeInTransaction } from '@/data/pipelineWake';
import { cloudRetryDelayMs } from '@/services/cloudRetryPolicy';
import {
  MainaCloudScopeError,
  pinMainaCloudExecutionContext,
  requireMainaCloudScope,
  type MainaCloudExecutionContext,
} from '@/services/mainaCloudSession';
import {
  listMkcMeetingTags,
  MkcMeetingTagsError,
  mutateMkcMeetingTags,
  readMkcMeetingTagState,
} from '@/services/mkc-meeting-tags';
import { MKC_MEMORY_FEATURE_FLAGS } from '@/services/mkc-memory-flags';
import { repairDurablePipelineScheduling } from '@/services/pipelineWakeScheduler';

const TAG_MUTATION_LEASE_MS = 60_000;

export type MeetingTagOutboxDrainResult = {
  disposition: 'disabled' | 'no_session' | 'completed';
  claimBudget: number;
  attempted: number;
  succeeded: number;
  retryable: number;
  reconciled: number;
  conflicted: number;
  terminal: number;
};

type MeetingTagOutboxOptions = {
  enabled?: boolean;
  assertActive?: () => Promise<void> | void;
  now?: () => number;
  leaseToken?: (now: number, ordinal: number) => string;
};

function featureEnabled(enabled: boolean | undefined): boolean {
  return enabled ?? MKC_MEMORY_FEATURE_FLAGS.mobileMeetingTagsV1;
}

function disabledError(): MkcMeetingTagsError {
  return new MkcMeetingTagsError('disabled', false, 'Meeting tags are not available in this build.');
}

async function requireWriteOwner(enabled: boolean | undefined): Promise<{
  ownerUserId: string;
  executionContext: MainaCloudExecutionContext;
}> {
  if (!featureEnabled(enabled)) throw disabledError();
  try {
    const session = await requireMainaCloudScope('sources:write');
    return {
      ownerUserId: session.user.userId,
      executionContext: pinMainaCloudExecutionContext(session),
    };
  } catch (cause) {
    if (cause instanceof MkcMeetingTagsError) throw cause;
    if (cause instanceof MainaCloudScopeError) {
      throw new MkcMeetingTagsError('auth', false, 'Reconnect Maina Cloud to use meeting tags.');
    }
    throw cause;
  }
}

function defaultLeaseToken(now: number, ordinal: number): string {
  return `meeting-tags:${now.toString(36)}:${ordinal.toString(36)}:${Math.random().toString(36).slice(2, 14)}`;
}

async function schedulePersistedWake(): Promise<void> {
  // The SQLite generation is authoritative. Native scheduling is a repairable
  // optimization and must not roll back an already durable offline mutation.
  await repairDurablePipelineScheduling().catch(() => ({ generation: null, scheduled: false }));
}

export async function queueMkcMeetingTagMutation(input: {
  request: unknown;
  enabled?: boolean;
  now?: number;
}): Promise<MeetingTagOutboxEntry> {
  const { ownerUserId } = await requireWriteOwner(input.enabled);
  const now = input.now ?? Date.now();
  const entry = await withDurableWakeTransaction(async (transaction) => {
    const queued = await enqueueMeetingTagMutationInTransaction(transaction, {
      ownerUserId,
      request: input.request,
      now,
    });
    if (queued.state === 'queued') {
      await persistDeferredPipelineWakeInTransaction(transaction, {
        notBeforeAt: now,
        requiresNetwork: true,
        now,
      });
    }
    return queued;
  });
  await schedulePersistedWake();
  return entry;
}

function classifyFailure(cause: unknown): {
  state: 'retryable' | 'terminal';
  failureCode: MeetingTagOutboxFailureCode;
  stopDrain: boolean;
} {
  const error = cause instanceof MkcMeetingTagsError
    ? cause
    : new MkcMeetingTagsError('protocol', false, 'Maina could not complete the meeting-tag request safely.');
  if (error.kind === 'offline') {
    return { state: 'retryable', failureCode: 'offline', stopDrain: false };
  }
  if (error.kind === 'retryable') {
    return { state: 'retryable', failureCode: 'http_retryable', stopDrain: false };
  }
  if (error.kind === 'session_changed') {
    return { state: 'retryable', failureCode: 'transport_retryable', stopDrain: true };
  }
  if (error.kind === 'auth') {
    return { state: 'terminal', failureCode: 'auth_required', stopDrain: true };
  }
  if (error.kind === 'forbidden' || error.kind === 'not_found' || error.kind === 'invalid') {
    return { state: 'terminal', failureCode: 'validation_rejected', stopDrain: false };
  }
  return { state: 'terminal', failureCode: 'protocol_rejected', stopDrain: false };
}

async function persistClaimFailure(
  claimed: MeetingTagOutboxEntry,
  cause: unknown,
  now: number,
): Promise<{ outcome: 'retryable' | 'terminal'; stopDrain: boolean }> {
  const classified = classifyFailure(cause);
  if (classified.state === 'retryable') {
    const nextAttemptAt = now + cloudRetryDelayMs(Math.max(0, claimed.attemptCount - 1));
    await withDurableWakeTransaction(async (transaction) => {
      await failMeetingTagMutationInTransaction(transaction, {
        ownerUserId: claimed.ownerUserId,
        idempotencyKey: claimed.idempotencyKey,
        leaseToken: claimed.leaseToken!,
        state: 'retryable',
        failureCode: classified.failureCode,
        nextAttemptAt,
        now,
      });
      await persistDeferredPipelineWakeInTransaction(transaction, {
        notBeforeAt: nextAttemptAt,
        requiresNetwork: true,
        now,
      });
    });
    return { outcome: 'retryable', stopDrain: classified.stopDrain };
  }
  await failMeetingTagMutation({
    ownerUserId: claimed.ownerUserId,
    idempotencyKey: claimed.idempotencyKey,
    leaseToken: claimed.leaseToken!,
    state: 'terminal',
    failureCode: classified.failureCode,
    now,
  });
  return { outcome: 'terminal', stopDrain: classified.stopDrain };
}

async function refreshConflict(
  claimed: MeetingTagOutboxEntry,
  executionContext: MainaCloudExecutionContext,
): Promise<unknown> {
  const operation = claimed.request.operation;
  if (operation.kind === 'create_definition' || operation.kind === 'rename_definition') {
    return listMkcMeetingTags({ enabled: true, executionContext });
  }
  return readMkcMeetingTagState(operation.source_key, { enabled: true, executionContext });
}

async function persistConflict(claimed: MeetingTagOutboxEntry, now: number): Promise<void> {
  await failMeetingTagMutation({
    ownerUserId: claimed.ownerUserId,
    idempotencyKey: claimed.idempotencyKey,
    leaseToken: claimed.leaseToken!,
    state: 'conflict',
    failureCode: 'revision_conflict',
    now,
  });
}

async function processClaim(
  claimed: MeetingTagOutboxEntry,
  executionContext: MainaCloudExecutionContext,
  checkpoint: () => Promise<void>,
  now: () => number,
): Promise<{ outcome: 'succeeded' | 'retryable' | 'reconciled' | 'conflicted' | 'terminal'; stopDrain: boolean }> {
  await checkpoint();
  let receipt: Awaited<ReturnType<typeof mutateMkcMeetingTags>>;
  try {
    receipt = await mutateMkcMeetingTags(claimed.request, { enabled: true, executionContext });
  } catch (cause) {
    if (!(cause instanceof MkcMeetingTagsError) || cause.kind !== 'conflict') {
      await checkpoint();
      return persistClaimFailure(claimed, cause, now());
    }

    await checkpoint();
    let canonicalState: unknown;
    try {
      canonicalState = await refreshConflict(claimed, executionContext);
    } catch (refreshCause) {
      await checkpoint();
      if (refreshCause instanceof MkcMeetingTagsError && refreshCause.retryable) {
        return persistClaimFailure(claimed, refreshCause, now());
      }
      // The remote mutation conflict is verified even when its canonical read
      // is unavailable or malformed. Preserve that blocking truth rather than
      // releasing the subject through a terminal refresh classification.
      await persistConflict(claimed, now());
      return {
        outcome: 'conflicted',
        stopDrain: refreshCause instanceof MkcMeetingTagsError && refreshCause.kind === 'auth',
      };
    }

    await checkpoint();
    const reconcileAt = now();
    try {
      await withDurableWakeTransaction((transaction) => (
        reconcileClaimedMeetingTagConflictInTransaction(transaction, {
          ownerUserId: claimed.ownerUserId,
          idempotencyKey: claimed.idempotencyKey,
          leaseToken: claimed.leaseToken!,
          canonicalState,
          now: reconcileAt,
        })
      ));
      return { outcome: 'reconciled', stopDrain: false };
    } catch (reconcileCause) {
      if (reconcileCause instanceof MeetingTagOutboxError
        && reconcileCause.reason === 'canonical_refresh_required') {
        await persistConflict(claimed, reconcileAt);
        return { outcome: 'conflicted', stopDrain: false };
      }
      throw reconcileCause;
    }
  }

  await checkpoint();
  await completeMeetingTagMutation({
    ownerUserId: claimed.ownerUserId,
    idempotencyKey: claimed.idempotencyKey,
    leaseToken: claimed.leaseToken!,
    receipt,
    now: now(),
  });
  return { outcome: 'succeeded', stopDrain: false };
}

export async function reconcilePendingMkcMeetingTagMutations(
  options: MeetingTagOutboxOptions = {},
): Promise<MeetingTagOutboxDrainResult> {
  const empty = {
    claimBudget: 0,
    attempted: 0,
    succeeded: 0,
    retryable: 0,
    reconciled: 0,
    conflicted: 0,
    terminal: 0,
  };
  if (!featureEnabled(options.enabled)) return { disposition: 'disabled', ...empty };

  let ownerUserId: string;
  let executionContext: MainaCloudExecutionContext;
  try {
    ({ ownerUserId, executionContext } = await requireWriteOwner(true));
  } catch (cause) {
    if (cause instanceof MkcMeetingTagsError && cause.kind === 'auth') {
      return { disposition: 'no_session', ...empty };
    }
    throw cause;
  }

  const now = options.now ?? Date.now;
  const checkpoint = async () => options.assertActive?.();
  const leaseToken = options.leaseToken ?? defaultLeaseToken;
  await checkpoint();
  const budgetAt = now();
  const claimBudget = await withDurableWakeTransaction((transaction) => (
    countClaimableMeetingTagMutationsInTransaction(transaction, { ownerUserId, now: budgetAt })
  ));
  const result: MeetingTagOutboxDrainResult = {
    disposition: 'completed',
    ...empty,
    claimBudget,
  };

  for (let ordinal = 0; ordinal < claimBudget; ordinal += 1) {
    await checkpoint();
    const claimAt = now();
    const claimed = await withDurableWakeTransaction((transaction) => (
      claimNextMeetingTagMutationInTransaction(transaction, {
        ownerUserId,
        leaseToken: leaseToken(claimAt, ordinal),
        now: claimAt,
        leaseMs: TAG_MUTATION_LEASE_MS,
      })
    ));
    if (!claimed) break;
    result.attempted += 1;
    const processed = await processClaim(claimed, executionContext, checkpoint, now);
    result[processed.outcome] += 1;
    if (processed.stopDrain) break;
  }
  return result;
}
