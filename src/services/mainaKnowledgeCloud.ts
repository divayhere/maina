import {
  getMeeting,
  getTranscriptPage,
  listMeetingTodos,
  listMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  listMeetingsNeedingKnowledgeCloudSync,
  updateMeeting,
  type Meeting,
  type TranscriptBlock,
} from '@/data/meetings';
import {
  getMainaKnowledgeCloudSettings,
} from '@/services/config';
import { log } from '@/services/logger';
import {
  buildMainaKnowledgeCloudSourcePackage,
  classifyMainaKnowledgeCloudResponse,
  isMeetingEligibleForMainaKnowledgeCloudSync,
  normalizeMainaKnowledgeCloudBaseUrl,
  type MainaKnowledgeCloudSourcePackage,
} from '@/services/mainaKnowledgeCloudCore';

const inflight = new Map<string, Promise<void>>();
const TRANSCRIPT_PAGE_SIZE = 100;

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

async function decodeResponseBody(response: Response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: {
        message: text,
      },
    };
  }
}

async function syncMeetingToMainaKnowledgeCloud(meetingId: string): Promise<void> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled) return;
  if (!settings.baseUrl.trim() || !settings.token.trim()) return;

  const meeting = await getMeeting(meetingId);
  if (!meeting || !isMeetingEligibleForMainaKnowledgeCloudSync(meeting)) return;

  const frozen = await freezePayloadSnapshot(meeting);
  if (!frozen) return;

  const baseUrl = normalizeMainaKnowledgeCloudBaseUrl(settings.baseUrl);
  await updateMeeting(meetingId, {
    knowledgeCloudSyncStatus: 'syncing',
    knowledgeCloudLastAttemptAt: Date.now(),
    knowledgeCloudError: null,
    knowledgeCloudSourceKey: frozen.payload.source_key,
  });

  try {
    const response = await fetch(`${baseUrl}/v1/sources`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.token}`,
        'Content-Type': 'application/json',
      },
      body: frozen.payloadJson,
    });
    const body = await decodeResponseBody(response);
    const result = classifyMainaKnowledgeCloudResponse({
      status: response.status,
      body,
    });

    if (result.outcome === 'success') {
      await updateMeeting(meetingId, {
        knowledgeCloudSyncStatus: 'sync_succeeded',
        knowledgeCloudSyncedAt: Date.now(),
        knowledgeCloudCanonicalSha256: result.canonicalSha256 ?? null,
        knowledgeCloudError: null,
      });
      log.info('maina-cloud', 'meeting synced', {
        meetingId,
        sourceKey: frozen.payload.source_key,
        status: response.status,
      });
      return;
    }

    if (result.outcome === 'auth_failed') {
      await updateMeeting(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_auth',
        knowledgeCloudError: result.message,
      });
      return;
    }

    if (result.outcome === 'conflict') {
      await updateMeeting(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_conflict',
        knowledgeCloudError: result.message,
      });
      return;
    }

    if (result.outcome === 'validation') {
      await updateMeeting(meetingId, {
        knowledgeCloudSyncStatus: 'sync_failed_validation',
        knowledgeCloudError: result.message,
      });
      return;
    }

    if (result.outcome === 'blocked_budget') {
      await updateMeeting(meetingId, {
        knowledgeCloudSyncStatus: 'sync_blocked_budget',
        knowledgeCloudError: result.message,
      });
      return;
    }

    await updateMeeting(meetingId, {
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
      knowledgeCloudError: result.message,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await updateMeeting(meetingId, {
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
      knowledgeCloudError: message,
    });
    log.warn('maina-cloud', 'meeting sync failed', {
      meetingId,
      err: message,
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
  options?: { includeAuthFailures?: boolean },
): Promise<boolean> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return false;

  const meeting = await getMeeting(meetingId);
  if (!meeting || !isMeetingEligibleForMainaKnowledgeCloudSync(meeting, options)) return false;

  const frozen = await freezePayloadSnapshot(meeting);
  if (!frozen) return false;

  await updateMeeting(meetingId, {
    knowledgeCloudSyncStatus: 'sync_queued',
    knowledgeCloudError: null,
    knowledgeCloudSourceKey: frozen.payload.source_key,
  });
  void runMainaKnowledgeCloudSync(meetingId);
  return true;
}

export async function queueEligibleMainaKnowledgeCloudSyncs(options?: {
  includeAuthFailures?: boolean;
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
  for (const meeting of pending) {
    void runMainaKnowledgeCloudSync(meeting.id);
  }
  await queueEligibleMainaKnowledgeCloudSyncs();
}
