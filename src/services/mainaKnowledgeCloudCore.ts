import { safeCloudFailureMessage, safePersistedCloudMessage } from '@/core/pipeline/cloudFailure';

export type MainaKnowledgeCloudSyncStatus =
  | 'local_only'
  | 'sync_queued'
  | 'syncing'
  | 'sync_succeeded'
  | 'sync_failed_auth'
  | 'sync_failed_retryable'
  | 'sync_failed_conflict'
  | 'sync_failed_validation'
  | 'sync_blocked_budget';

export type MainaKnowledgeCloudTone = 'muted' | 'primary' | 'warn';

export type MainaKnowledgeCloudMeetingShape = {
  id: string;
  title: string;
  startedAt: number;
  status: string;
  summaryStatus: string;
  transcript?: string | null;
  summary?: string | null;
  decisions: string[];
  openQuestions: string[];
  language?: string | null;
  segmentCount: number;
  transcribedSegments: number;
  knowledgeCloudSyncStatus: MainaKnowledgeCloudSyncStatus;
  knowledgeCloudPayloadJson?: string | null;
  knowledgeCloudError?: string | null;
};

export type MainaKnowledgeCloudTranscriptBlockShape = {
  blockId: string;
  sequence: number;
  startedAt?: number | null;
  endedAt?: number | null;
  language?: string | null;
  text: string;
};

export type MainaKnowledgeCloudTodoShape = {
  text: string;
};

type CanonicalBlock = {
  block_key: string;
  kind: 'transcript';
  text: string;
  started_at?: string;
  ended_at?: string;
  metadata?: Record<string, string>;
};

export type MainaKnowledgeCloudSourcePackage = {
  schema_version: 'mkc.source.v1';
  source_key: string;
  source_type: 'meeting';
  title: string;
  occurred_at: string;
  workspace: {
    key: string;
    name: string;
  };
  project: {
    key: string;
    name: string;
  };
  topics: {
    key: string;
    label: string;
    confidence?: number;
  }[];
  provenance: {
    origin: 'maina-android';
    author: 'maina-app';
    captured_at: string;
    client_schema_version: 'maina.sync.v1';
  };
  content: {
    text: string;
    blocks?: CanonicalBlock[];
    summary?: string;
    decisions?: string[];
    todos?: string[];
    open_questions?: string[];
    important_points?: string[];
  };
  metadata: Record<string, string | number | boolean | null>;
};

export type MainaKnowledgeCloudResponseClassification =
  | { outcome: 'success'; canonicalSha256?: string | null }
  | { outcome: 'auth_failed'; message: string }
  | { outcome: 'conflict'; message: string }
  | { outcome: 'validation'; message: string }
  | { outcome: 'blocked_budget'; message: string }
  | { outcome: 'retryable'; message: string };

const MAX_TITLE = 500;
const MAX_TEXT_FIELD = 5000;
const MAX_BLOCKS = 64;
const MAX_LIST_ITEMS = 50;

function trimText(value: string | null | undefined, max: number) {
  return (value ?? '').trim().slice(0, max);
}

function compactList(items: string[], maxItems = MAX_LIST_ITEMS) {
  return items
    .map((item) => trimText(item, MAX_TEXT_FIELD))
    .filter(Boolean)
    .slice(0, maxItems);
}

function isoFromMillis(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

export function normalizeMainaKnowledgeCloudBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export function mainaKnowledgeCloudSourceKey(meetingId: string) {
  return `meeting:maina:${meetingId}`;
}

export function isMeetingEligibleForMainaKnowledgeCloudSync(
  meeting: MainaKnowledgeCloudMeetingShape,
  options?: { includeAuthFailures?: boolean },
) {
  // Never freeze or retry a source from a transcript that Maina itself knows
  // has missing ASR coverage. Recovery/correction must happen first.
  if (meeting.status === 'transcript_partial' || meeting.status === 'audio_expired_incomplete') return false;
  if (meeting.knowledgeCloudSyncStatus === 'sync_succeeded') return false;
  if (meeting.knowledgeCloudSyncStatus === 'sync_failed_conflict') return false;
  if (meeting.knowledgeCloudSyncStatus === 'sync_failed_validation') return false;

  if (meeting.knowledgeCloudPayloadJson?.trim()) {
    return (
      meeting.knowledgeCloudSyncStatus === 'sync_queued'
      || meeting.knowledgeCloudSyncStatus === 'syncing'
      || meeting.knowledgeCloudSyncStatus === 'sync_failed_retryable'
      || meeting.knowledgeCloudSyncStatus === 'sync_blocked_budget'
      || (options?.includeAuthFailures === true
        && meeting.knowledgeCloudSyncStatus === 'sync_failed_auth')
      || meeting.knowledgeCloudSyncStatus === 'local_only'
    );
  }

  const transcriptReady = meeting.status === 'transcribed' || meeting.status === 'summarized';
  const summaryBusy = meeting.summaryStatus === 'queued' || meeting.summaryStatus === 'running';
  return transcriptReady && !summaryBusy;
}

export function buildMainaKnowledgeCloudSourcePackage(input: {
  meeting: MainaKnowledgeCloudMeetingShape;
  transcriptText: string;
  blocks: MainaKnowledgeCloudTranscriptBlockShape[];
  todos: MainaKnowledgeCloudTodoShape[];
}): MainaKnowledgeCloudSourcePackage {
  const meeting = input.meeting;
  const transcriptText = input.transcriptText.trim();

  const blocks = input.blocks
    .filter((block) => block.text.trim())
    .sort((left, right) => left.sequence - right.sequence)
    .slice(0, MAX_BLOCKS)
    .map<CanonicalBlock>((block) => ({
      block_key: block.blockId,
      kind: 'transcript',
      text: trimText(block.text, MAX_TEXT_FIELD),
      ...(isoFromMillis(block.startedAt) ? { started_at: isoFromMillis(block.startedAt) } : {}),
      ...(isoFromMillis(block.endedAt) ? { ended_at: isoFromMillis(block.endedAt) } : {}),
      ...(block.language ? { metadata: { language: block.language } } : {}),
    }));

  const summary = trimText(meeting.summary, MAX_TEXT_FIELD);
  const decisions = compactList(meeting.decisions);
  const todos = compactList(input.todos.map((todo) => todo.text));
  const openQuestions = compactList(meeting.openQuestions);
  const importantPoints = compactList(
    [summary, ...decisions, ...openQuestions].filter(Boolean),
  ).slice(0, 12);

  return {
    schema_version: 'mkc.source.v1',
    source_key: mainaKnowledgeCloudSourceKey(meeting.id),
    source_type: 'meeting',
    title: trimText(meeting.title || 'Meeting', MAX_TITLE) || 'Meeting',
    occurred_at: new Date(meeting.startedAt).toISOString(),
    workspace: {
      key: 'maina',
      name: 'Maina',
    },
    project: {
      key: 'captured-meetings',
      name: 'Captured Meetings',
    },
    topics: [],
    provenance: {
      origin: 'maina-android',
      author: 'maina-app',
      captured_at: new Date(meeting.startedAt).toISOString(),
      client_schema_version: 'maina.sync.v1',
    },
    content: {
      text: transcriptText,
      ...(blocks.length > 0 ? { blocks } : {}),
      ...(summary ? { summary } : {}),
      ...(decisions.length > 0 ? { decisions } : {}),
      ...(todos.length > 0 ? { todos } : {}),
      ...(openQuestions.length > 0 ? { open_questions: openQuestions } : {}),
      ...(importantPoints.length > 0 ? { important_points: importantPoints } : {}),
    },
    metadata: {
      local_status: meeting.status,
      summary_status: meeting.summaryStatus,
      language: meeting.language ?? null,
      segment_count: meeting.segmentCount,
      transcribed_segments: meeting.transcribedSegments,
    },
  };
}

export function classifyMainaKnowledgeCloudResponse(input: {
  status: number;
  body: unknown;
}): MainaKnowledgeCloudResponseClassification {
  const body = input.body as
    | {
        error?: { code?: string; message?: string };
        canonical_sha256?: string;
        status?: string;
      }
    | null;

  if (input.status === 200 || input.status === 201) {
    return {
      outcome: 'success',
      canonicalSha256: body?.canonical_sha256 ?? null,
    };
  }

  const message = body?.error?.message ?? `Maina Knowledge Cloud request failed with ${input.status}.`;
  if (input.status === 401 || input.status === 403) {
    return { outcome: 'auth_failed', message };
  }
  if (input.status === 409) return { outcome: 'conflict', message };
  if (input.status === 422) return { outcome: 'validation', message };
  if (input.status === 503 && body?.error?.code === 'budget_guardrail_blocked') {
    return { outcome: 'blocked_budget', message };
  }
  return { outcome: 'retryable', message };
}

export function describeMainaKnowledgeCloudSyncStatus(input: {
  status: MainaKnowledgeCloudSyncStatus;
  error?: string | null;
}) {
  const fallback = input.status === 'sync_failed_auth'
    ? safeCloudFailureMessage('auth')
    : input.status === 'sync_failed_retryable' || input.status === 'sync_blocked_budget'
      ? safeCloudFailureMessage('backend_retryable')
      : safeCloudFailureMessage('backend_terminal');
  const safeError = safePersistedCloudMessage(input.error, fallback);
  switch (input.status) {
    case 'sync_succeeded':
      return { label: 'Synced to cloud', detail: 'This meeting is stored in Maina Knowledge Cloud.', tone: 'primary' as MainaKnowledgeCloudTone };
    case 'sync_failed_auth':
      return { label: 'Cloud connection needs attention', detail: safeError, tone: 'warn' as MainaKnowledgeCloudTone };
    case 'sync_queued':
      return { label: 'Waiting to sync', detail: 'This meeting is queued for Maina Knowledge Cloud.', tone: 'muted' as MainaKnowledgeCloudTone };
    case 'syncing':
      return { label: 'Syncing now', detail: 'Maina is sending this meeting to Maina Knowledge Cloud.', tone: 'muted' as MainaKnowledgeCloudTone };
    case 'sync_failed_conflict':
      return { label: 'Cloud conflict', detail: safeError, tone: 'warn' as MainaKnowledgeCloudTone };
    case 'sync_failed_validation':
      return { label: 'Cloud format issue', detail: safeError, tone: 'warn' as MainaKnowledgeCloudTone };
    case 'sync_blocked_budget':
      return { label: 'Cloud sync paused', detail: safeError, tone: 'warn' as MainaKnowledgeCloudTone };
    case 'sync_failed_retryable':
      return { label: 'Cloud sync waiting', detail: 'Maina will continue automatically when the cloud is reachable.', tone: 'muted' as MainaKnowledgeCloudTone };
    case 'local_only':
    default:
      return { label: 'Only on this phone', detail: 'This meeting has not been sent to Maina Knowledge Cloud yet.', tone: 'muted' as MainaKnowledgeCloudTone };
  }
}
