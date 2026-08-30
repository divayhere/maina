import {
  getMeeting,
  getTranscriptPage,
  listMeetingTodos,
  listMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  listMeetingsNeedingKnowledgeCloudSync,
  persistKnowledgeCloudSourceRetry,
  updateMeeting,
  updateMeetingPipelineStage,
  type Meeting,
  type TranscriptBlock,
} from '@/data/meetings';
import {
  getMainaKnowledgeCloudSettings,
} from '@/services/config';
import { log } from '@/services/logger';
import { clearMainaCloudSession, mainaCloudRequestJson } from '@/services/mainaCloudSession';
import { notifyMeetingPipelineChanged } from '@/services/meetingPipelineSignals';
import {
  buildMainaKnowledgeCloudSourcePackage,
  classifyMainaKnowledgeCloudResponse,
  isMeetingEligibleForMainaKnowledgeCloudSync,
  type MainaKnowledgeCloudSourcePackage,
} from '@/services/mainaKnowledgeCloudCore';
import { reconcileMainaKnowledgeCloudCorrectionsForMeeting } from '@/services/mainaKnowledgeCloudCorrections';
import {
  classifyTransportCause,
  safeCloudFailureMessage,
} from '@/core/pipeline/cloudFailure';
import { isRetryableCloudFailure, nextCloudRetry } from '@/services/cloudRetryPolicy';
import { armPipelineNetworkRecovery } from '@/services/pipelineWakeScheduler';

const inflight = new Map<string, Promise<void>>();
const TRANSCRIPT_PAGE_SIZE = 100;

async function setCloudSyncState(
  meetingId: string,
  patch: Parameters<typeof updateMeeting>[1],
): Promise<void> {
  await updateMeeting(meetingId, patch);
  const status = patch.knowledgeCloudSyncStatus;
  if (!status) return;
  const state = status === 'sync_queued'
    ? 'queued'
    : status === 'syncing'
      ? 'running'
      : status === 'sync_succeeded'
        ? 'ready'
        : status === 'sync_failed_retryable' || status === 'sync_blocked_budget'
          ? 'deferred'
          : status === 'local_only'
            ? 'pending'
            : 'failed';
  await updateMeetingPipelineStage({
    meetingId,
    stage: 'mkc',
    state,
    completedUnits: state === 'ready' ? 1 : 0,
    totalUnits: 1,
    error: patch.knowledgeCloudError,
  });
  notifyMeetingPipelineChanged(meetingId);
}

async function setCloudSyncRetryState(input: {
  meetingId: string;
  syncStatus: 'sync_failed_retryable' | 'sync_blocked_budget';
  retryCount: number;
  lastRetryAt: number;
  nextRetryAt: number;
  failureClass: Parameters<typeof persistKnowledgeCloudSourceRetry>[0]['failureClass'];
  visibleError: string;
}): Promise<void> {
  await persistKnowledgeCloudSourceRetry(input);
  await updateMeetingPipelineStage({
    meetingId: input.meetingId,
    stage: 'mkc',
    state: 'deferred',
    completedUnits: 0,
    totalUnits: 1,
    error: input.visibleError,
    metadata: {
      retryAt: input.nextRetryAt,
      failureClass: input.failureClass,
    },
  });
  notifyMeetingPipelineChanged(input.meetingId);
}

function parseStoredPayload(payloadJson: string): MainaKnowledgeCloudSourcePackage | null {
  try {
    return JSON.parse(payloadJson) as MainaKnowledgeCloudSourcePackage;
  } catch {
    return null;
  }
}

async function loadAllTranscriptBlocks(meetingId: string): Promise<TranscriptBlock[]> {
  const blocks: TranscriptBlock[] = [];
  let offset = 0;

  while (true) {
    const page = await getTranscriptPage(meetingId, {
      offset,
      limit: TRANSCRIPT_PAGE_SIZE,
      includeDraft: true,
    });
    if (page.blocks.length === 0) break;
    blocks.push(...page.blocks);
    if (!page.hasMore || page.source !== 'blocks') break;
    offset += page.blocks.length;
  }

  return blocks;
}

function buildTranscriptText(blocks: TranscriptBlock[]) {
  return blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function freezePayloadSnapshot(meeting: Meeting) {
  if (meeting.knowledgeCloudPayloadJson?.trim()) {
    const payload = parseStoredPayload(meeting.knowledgeCloudPayloadJson);
    if (payload) {
      return {
        payload,
        payloadJson: meeting.knowledgeCloudPayloadJson,
      };
    }
  }

  const [blocks, todos] = await Promise.all([
    loadAllTranscriptBlocks(meeting.id),
    listMeetingTodos(meeting.id),
  ]);
  const transcriptText = buildTranscriptText(blocks);
  if (!transcriptText) return null;

  const payload = buildMainaKnowledgeCloudSourcePackage({
    meeting,
    transcriptText,
    blocks,
    todos,
  });
  const payloadJson = JSON.stringify(payload);
  await updateMeeting(meeting.id, {
    knowledgeCloudSourceKey: payload.source_key,
    knowledgeCloudPayloadJson: payloadJson,
  });
  return { payload, payloadJson };
}

async function syncMeetingToMainaKnowledgeCloud(meetingId: string): Promise<void> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled) return;
  if (!settings.baseUrl.trim() || !settings.token.trim()) return;

  const meeting = await getMeeting(meetingId);
  if (!meeting || !isMeetingEligibleForMainaKnowledgeCloudSync(meeting)) return;
  if ((meeting.knowledgeCloudSyncStatus === 'sync_failed_retryable'
      || meeting.knowledgeCloudSyncStatus === 'sync_blocked_budget')
    && meeting.knowledgeCloudNextRetryAt != null
    && meeting.knowledgeCloudNextRetryAt > Date.now()) return;

  const frozen = await freezePayloadSnapshot(meeting);
  if (!frozen) return;

  await armPipelineNetworkRecovery();
  await setCloudSyncState(meetingId, {
    knowledgeCloudSyncStatus: 'syncing',
    knowledgeCloudLastAttemptAt: Date.now(),
    knowledgeCloudError: null,
    knowledgeCloudFailureClass: null,
    knowledgeCloudSourceKey: frozen.payload.source_key,
  });

  try {
    const response = await mainaCloudRequestJson('/v1/sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: frozen.payloadJson,
    }, { acceptHttpErrors: true });
    const result = classifyMainaKnowledgeCloudResponse({
      status: response.status,
      body: response.data,
    });

    if (result.outcome === 'success') {
      await setCloudSyncState(meetingId, {
        knowledgeCloudSyncStatus: 'sync_succeeded',
        knowledgeCloudSyncedAt: Date.now(),
        knowledgeCloudCanonicalSha256: result.canonicalSha256 ?? null,
        knowledgeCloudError: null,
        knowledgeCloudFailureClass: null,
        knowledgeCloudRetryCount: 0,
        knowledgeCloudNextRetryAt: null,
      });
      log.info('maina-cloud', 'meeting synced', {
        meetingId,
        sourceKey: frozen.payload.source_key,
        status: response.status,
      });
      void reconcileMainaKnowledgeCloudCorrectionsForMeeting(meetingId).catch((cause) => {
        log.warn('maina-cloud-correction', 'correction reconciliation after source sync failed', {
          meetingId,
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
      });
      return;
    }

    if (result.outcome === 'auth_failed') {
      // The settings façade derives this credential only from the paired
      // SecureStore session. Clear an invalid session, never local meeting
      // evidence, so Settings can truthfully offer a reconnect.
      await clearMainaCloudSession();
      await setCloudSyncState(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_auth',
        knowledgeCloudError: safeCloudFailureMessage('auth'),
        knowledgeCloudFailureClass: 'auth',
      });
      return;
    }

    if (result.outcome === 'conflict') {
      await setCloudSyncState(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_conflict',
        knowledgeCloudError: safeCloudFailureMessage('backend_terminal'),
        knowledgeCloudFailureClass: 'backend_terminal',
      });
      return;
    }

    if (result.outcome === 'validation') {
      await setCloudSyncState(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_validation',
        knowledgeCloudError: safeCloudFailureMessage('backend_terminal'),
        knowledgeCloudFailureClass: 'backend_terminal',
      });
      return;
    }

    if (result.outcome === 'blocked_budget') {
      const retry = nextCloudRetry({ attemptCount: meeting.knowledgeCloudRetryCount ?? 0 });
      await setCloudSyncRetryState({
        meetingId,
        syncStatus: 'sync_blocked_budget',
        visibleError: safeCloudFailureMessage('backend_retryable'),
        failureClass: 'backend_retryable',
        retryCount: retry.attemptCount,
        lastRetryAt: retry.lastRetryAt,
        nextRetryAt: retry.nextRetryAt,
      });
      return;
    }

    const retry = nextCloudRetry({ attemptCount: meeting.knowledgeCloudRetryCount ?? 0 });
    await setCloudSyncRetryState({
      meetingId,
      syncStatus: 'sync_failed_retryable',
      visibleError: safeCloudFailureMessage('http_retryable'),
      failureClass: 'http_retryable',
      retryCount: retry.attemptCount,
      lastRetryAt: retry.lastRetryAt,
      nextRetryAt: retry.nextRetryAt,
    });
  } catch (cause) {
    const classified = classifyTransportCause(cause);
    const retryable = isRetryableCloudFailure(cause);
    const failureClass = retryable || ['auth', 'http_terminal', 'backend_terminal', 'protocol'].includes(classified)
      ? classified
      : 'protocol';
    if (retryable) {
      const retry = nextCloudRetry({ attemptCount: meeting.knowledgeCloudRetryCount ?? 0 });
      await setCloudSyncRetryState({
        meetingId,
        syncStatus: 'sync_failed_retryable',
        visibleError: safeCloudFailureMessage(failureClass),
        failureClass,
        retryCount: retry.attemptCount,
        lastRetryAt: retry.lastRetryAt,
        nextRetryAt: retry.nextRetryAt,
      });
    } else {
      if (failureClass === 'auth') await clearMainaCloudSession();
      await setCloudSyncState(meetingId, {
        knowledgeCloudSyncStatus: failureClass === 'auth' ? 'sync_failed_auth' : 'sync_failed_validation',
        knowledgeCloudError: safeCloudFailureMessage(failureClass),
        knowledgeCloudFailureClass: failureClass,
        knowledgeCloudNextRetryAt: null,
      });
    }
    log.warn('maina-cloud', 'meeting sync failed', {
      meetingId,
      failureClass,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}

export function runMainaKnowledgeCloudSync(meetingId: string): Promise<void> {
  const existing = inflight.get(meetingId);
  if (existing) return existing;

  const task = syncMeetingToMainaKnowledgeCloud(meetingId).finally(() => {
    inflight.delete(meetingId);
  });
  inflight.set(meetingId, task);
  return task;
}

export async function maybeQueueMainaKnowledgeCloudSync(
  meetingId: string,
  options?: { includeAuthFailures?: boolean; forceRetry?: boolean },
): Promise<boolean> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return false;

  const meeting = await getMeeting(meetingId);
  if (!meeting || !isMeetingEligibleForMainaKnowledgeCloudSync(meeting, options)) return false;
  if (options?.forceRetry !== true
    && (meeting.knowledgeCloudSyncStatus === 'sync_failed_retryable'
      || meeting.knowledgeCloudSyncStatus === 'sync_blocked_budget')
    && meeting.knowledgeCloudNextRetryAt != null
    && meeting.knowledgeCloudNextRetryAt > Date.now()) return false;

  const frozen = await freezePayloadSnapshot(meeting);
  if (!frozen) return false;

  await setCloudSyncState(meetingId, {
    knowledgeCloudSyncStatus: 'sync_queued',
    knowledgeCloudError: null,
    knowledgeCloudSourceKey: frozen.payload.source_key,
  });
  void runMainaKnowledgeCloudSync(meetingId);
  return true;
}

export async function queueEligibleMainaKnowledgeCloudSyncs(options?: {
  includeAuthFailures?: boolean;
  forceRetry?: boolean;
}): Promise<number> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return 0;

  const meetings = await listMeetingsEligibleForKnowledgeCloudQueueWithOptions(options);
  let queued = 0;
  for (const meeting of meetings) {
    if (await maybeQueueMainaKnowledgeCloudSync(meeting.id, options)) {
      queued += 1;
    }
  }
  log.info('maina-cloud', 'eligible meetings queued', { count: queued });
  return queued;
}

export async function reconcilePendingMainaKnowledgeCloudSyncs(): Promise<void> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return;

  const pending = await listMeetingsNeedingKnowledgeCloudSync();
  await Promise.all(pending.map((meeting) => runMainaKnowledgeCloudSync(meeting.id)));
  await queueEligibleMainaKnowledgeCloudSyncs();
  const newlyQueued = await listMeetingsNeedingKnowledgeCloudSync();
  await Promise.all(newlyQueued.map((meeting) => runMainaKnowledgeCloudSync(meeting.id)));
}
