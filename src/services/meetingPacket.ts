import {
  buildTranscriptText,
  getMeeting,
  getTranscriptPage,
  listMeetingTodos,
  listMeetingsEligibleForSummaryQueue,
  replaceMeetingTodos,
  saveMeetingPacket,
  setMeetingSummaryState,
  type Meeting,
  type TranscriptBlock,
  updateMeeting,
  updateMeetingPipelineStage,
} from '@/data/meetings';
import { getAppConfig } from '@/services/config';
import { log } from '@/services/logger';
import { maybeQueueMainaKnowledgeCloudSync } from '@/services/mainaKnowledgeCloud';
import { maybeQueueMainaKnowledgeCloudPacketCorrections } from '@/services/mainaKnowledgeCloudCorrections';
import { mainaKnowledgeCloudSourceKey } from '@/services/mainaKnowledgeCloudCore';
import { MainaCloudApiError, getMainaCloudSession, mainaCloudFetch } from '@/services/mainaCloudSession';
import { notifyMeetingPacketChanged } from '@/services/meetingPacketSignals';

const inflight = new Map<string, Promise<void>>();
let executionTail: Promise<void> = Promise.resolve();
const TRANSCRIPT_PAGE_SIZE = 100;
const MAX_AUTOMATIC_RETRIES = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

type CloudPacketTodo = { text: string; source_quote?: string; source_timestamp?: string };
type CloudPacket = {
  title: string;
  summary: string;
  decisions: string[];
  todos: CloudPacketTodo[];
  open_questions: string[];
};
type CloudPacketJob = {
  job_id: string;
  source_key: string;
  packet_version: string;
  status: 'queued' | 'processing' | 'ready' | 'failed_retryable' | 'failed_auth' | 'failed_validation' | 'blocked_budget';
  provider?: string | null;
  model?: string | null;
  progress?: { completed_sections?: number; total_sections?: number } | null;
  error?: { code?: string; message?: string } | null;
  packet?: CloudPacket | null;
};

function safePacket(value: unknown): CloudPacket | null {
  const packet = value as Partial<CloudPacket> | null;
  if (!packet || typeof packet.title !== 'string' || typeof packet.summary !== 'string') return null;
  if (!Array.isArray(packet.decisions) || !Array.isArray(packet.todos) || !Array.isArray(packet.open_questions)) return null;
  return {
    title: packet.title,
    summary: packet.summary,
    decisions: packet.decisions.filter((item): item is string => typeof item === 'string'),
    todos: packet.todos.filter((item): item is CloudPacketTodo => !!item && typeof item === 'object' && typeof item.text === 'string'),
    open_questions: packet.open_questions.filter((item): item is string => typeof item === 'string'),
  };
}

function parseJob(value: unknown): CloudPacketJob | null {
  const job = value as Partial<CloudPacketJob> | null;
  const validStates = new Set(['queued', 'processing', 'ready', 'failed_retryable', 'failed_auth', 'failed_validation', 'blocked_budget']);
  if (!job || typeof job.job_id !== 'string' || typeof job.source_key !== 'string' || typeof job.packet_version !== 'string' || typeof job.status !== 'string' || !validStates.has(job.status)) return null;
  return {
    job_id: job.job_id,
    source_key: job.source_key,
    packet_version: job.packet_version,
    status: job.status as CloudPacketJob['status'],
    provider: typeof job.provider === 'string' ? job.provider : null,
    model: typeof job.model === 'string' ? job.model : null,
    progress: job.progress && typeof job.progress === 'object' ? job.progress : null,
    error: job.error && typeof job.error === 'object' ? job.error : null,
    packet: safePacket(job.packet),
  };
}

async function responseJson(response: Response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

async function loadTranscriptBlocks(meetingId: string): Promise<TranscriptBlock[]> {
  const blocks: TranscriptBlock[] = [];
  let offset = 0;
  while (true) {
    const page = await getTranscriptPage(meetingId, { offset, limit: TRANSCRIPT_PAGE_SIZE, includeDraft: false });
    blocks.push(...page.blocks.filter((block) => block.text.trim()));
    if (!page.hasMore || page.source !== 'blocks') break;
    offset += page.blocks.length;
  }
  return blocks;
}

function packetVersion(meeting: Meeting, regenerate: boolean) {
  if (!regenerate) return 'meeting-packet-v3';
  return `meeting-packet-v3-revision-${Date.now()}-${meeting.id.slice(0, 8)}`;
}

function formatCloudError(error: unknown) {
  if (error instanceof MainaCloudApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

async function setJobState(meetingId: string, job: CloudPacketJob, error?: string | null) {
  const completedSections = Math.max(0, Number(job.progress?.completed_sections ?? 0));
  const totalSections = Math.max(1, Number(job.progress?.total_sections ?? 1));
  const isRunning = job.status === 'queued' || job.status === 'processing';
  await updateMeeting(meetingId, {
    cloudNotesJobId: job.job_id,
    cloudNotesLastPolledAt: Date.now(),
    summaryProviderId: job.provider ?? null,
    summaryModel: job.model ?? null,
  });
  await setMeetingSummaryState(
    meetingId,
    isRunning ? 'running' : 'failed',
    {
      providerId: job.provider ?? null,
      model: job.model ?? null,
      error: error ?? job.error?.message ?? null,
    },
  );
  // Keep the visible pipeline truthful for long meetings. The database stage is
  // intentionally independent of the meeting's local transcript status.
  await updateMeetingPipelineStage({
    meetingId,
    stage: 'summary',
    state: isRunning ? (job.status === 'queued' ? 'queued' : 'running') : 'failed',
    completedUnits: completedSections,
    totalUnits: totalSections,
    error: error ?? job.error?.message ?? null,
    metadata: {
      cloudJobId: job.job_id,
      provider: job.provider ?? null,
      model: job.model ?? null,
    },
  });
  log.info('summary', 'cloud meeting packet state observed', {
    meetingId,
    jobId: job.job_id,
    status: job.status,
    completedSections,
    totalSections,
  });
}

async function saveReadyPacket(meeting: Meeting, job: CloudPacketJob) {
  const packet = job.packet;
  if (!packet) throw new Error('Maina Cloud marked notes ready but returned no packet. Maina will retry safely.');
  await saveMeetingPacket({
    meetingId: meeting.id,
    title: packet.title,
    summary: packet.summary,
    decisions: packet.decisions,
    openQuestions: packet.open_questions,
    providerId: job.provider ?? 'maina-cloud',
    model: job.model ?? 'managed',
    summarizedAt: Date.now(),
  });
  await replaceMeetingTodos(meeting.id, packet.todos.map((todo) => ({
    text: todo.text,
    sourceQuote: todo.source_quote ?? null,
    sourceSpeakerId: null,
    sourceTimestamp: null,
    origin: 'ai',
  })));
  await updateMeeting(meeting.id, {
    cloudNotesJobId: job.job_id,
    cloudNotesLastPolledAt: Date.now(),
    cloudNotesRetryCount: 0,
    cloudNotesLastRetryAt: null,
  });

  const todos = await listMeetingTodos(meeting.id);
  if (meeting.knowledgeCloudSyncStatus === 'sync_succeeded') {
    await maybeQueueMainaKnowledgeCloudPacketCorrections({
      meetingId: meeting.id,
      packet: {
        title: packet.title,
        summary: packet.summary,
        decisions: packet.decisions,
        todos: todos.map((todo) => todo.text),
        openQuestions: packet.open_questions,
      },
      providerId: job.provider ?? 'maina-cloud',
      model: job.model ?? 'managed',
    });
  } else {
    // Freeze the immutable source only after durable server notes exist.
    await maybeQueueMainaKnowledgeCloudSync(meeting.id);
  }
}

async function createCloudJob(meeting: Meeting, regenerate: boolean): Promise<CloudPacketJob> {
  const [transcript, blocks] = await Promise.all([
    buildTranscriptText(meeting.id, { includeTimestamps: false }),
    loadTranscriptBlocks(meeting.id),
  ]);
  if (!transcript.text.trim()) throw new Error('No durable transcript text is available yet. Maina will keep processing audio first.');
  const response = await mainaCloudFetch('/v1/meeting-packets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'mkc.meeting-packet.v1',
      source_key: mainaKnowledgeCloudSourceKey(meeting.id),
      title: meeting.title?.trim() || 'Meeting',
      occurred_at: new Date(meeting.startedAt).toISOString(),
      ...(meeting.language ? { language: meeting.language } : {}),
      packet_version: packetVersion(meeting, regenerate),
      transcript: {
        text: transcript.text,
        ...(blocks.length > 0 ? { blocks: blocks.map((block) => ({
          text: block.text,
          ...(block.startedAt ? { started_at: new Date(block.startedAt).toISOString() } : {}),
          ...(block.endedAt ? { ended_at: new Date(block.endedAt).toISOString() } : {}),
        })) } : {}),
      },
    }),
  });
  const job = parseJob(await responseJson(response));
  if (!job) throw new Error('Maina Cloud returned an invalid notes-job response. Maina will retry safely.');
  return job;
}

async function getCloudJob(jobId: string): Promise<CloudPacketJob> {
  const response = await mainaCloudFetch(`/v1/meeting-packets/${encodeURIComponent(jobId)}`);
  const job = parseJob(await responseJson(response));
  if (!job) throw new Error('Maina Cloud returned an invalid notes status. Maina will retry safely.');
  return job;
}

async function retryCloudJob(jobId: string): Promise<CloudPacketJob> {
  const response = await mainaCloudFetch(`/v1/meeting-packets/${encodeURIComponent(jobId)}/retry`, { method: 'POST' });
  const job = parseJob(await responseJson(response));
  if (!job) throw new Error('Maina Cloud could not requeue the notes job. Maina will retry safely.');
  return job;
}

async function reconcileMeetingPacket(meetingId: string, options?: { regenerate?: boolean }): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  if (!(meeting.status === 'transcribed' || meeting.status === 'summarizing' || meeting.status === 'summarized')) return;
  if (!await getMainaCloudSession()) {
    await setMeetingSummaryState(meetingId, 'failed', { error: 'Connect Maina Cloud once to create notes automatically.' });
    return;
  }
  try {
    const shouldCreate = options?.regenerate === true || !meeting.cloudNotesJobId;
    let job = shouldCreate ? await createCloudJob(meeting, options?.regenerate === true) : await getCloudJob(meeting.cloudNotesJobId!);
    if (job.status === 'ready') {
      await saveReadyPacket(meeting, job);
      return;
    }
    if (job.status === 'failed_retryable') {
      const now = Date.now();
      const retryCount = meeting.cloudNotesRetryCount ?? 0;
      const retryEligible = retryCount < MAX_AUTOMATIC_RETRIES
        && (!meeting.cloudNotesLastRetryAt || now - meeting.cloudNotesLastRetryAt >= RETRY_COOLDOWN_MS);
      if (retryEligible) {
        await updateMeeting(meetingId, { cloudNotesRetryCount: retryCount + 1, cloudNotesLastRetryAt: now });
        job = await retryCloudJob(job.job_id);
      }
    }
    await setJobState(meetingId, job);
  } catch (cause) {
    const error = formatCloudError(cause);
    const authFailure = cause instanceof MainaCloudApiError && (cause.status === 401 || cause.status === 403);
    await setMeetingSummaryState(meetingId, 'failed', {
      error: authFailure ? 'Maina Cloud needs to be reconnected. Your transcript is safe on this phone.' : error,
    });
    log.warn('summary', 'cloud meeting packet reconciliation failed', { meetingId, err: error });
  }
}

export function runMeetingPacketGeneration(meetingId: string, options?: { regenerate?: boolean }): Promise<void> {
  const key = `${meetingId}:${options?.regenerate ? 'regenerate' : 'normal'}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  // Expo SQLite exposes one shared native connection. Applying multiple ready
  // packets concurrently can overlap todo replacement transactions. Keep
  // network/status/application work ordered; meetings still queue instantly.
  const task = executionTail
    .catch(() => {})
    .then(() => reconcileMeetingPacket(meetingId, options))
    .finally(() => {
      inflight.delete(key);
      notifyMeetingPacketChanged(meetingId);
    });
  executionTail = task.then(() => {}, () => {});
  inflight.set(key, task);
  return task;
}

export async function maybeQueueMeetingPacket(meetingId: string): Promise<void> {
  const config = await getAppConfig();
  if (!config.autoSummarize || !await getMainaCloudSession()) return;
  const meeting = await getMeeting(meetingId);
  if (!meeting || !(meeting.status === 'transcribed' || meeting.status === 'summarizing' || meeting.status === 'summarized')) return;
  await setMeetingSummaryState(meetingId, 'queued').catch(() => {});
  void runMeetingPacketGeneration(meetingId);
}

export async function reconcilePendingMeetingPackets(): Promise<number> {
  if (!await getMainaCloudSession()) return 0;
  const now = Date.now();
  const meetings = (await listMeetingsEligibleForSummaryQueue()).filter((meeting) => {
    if (meeting.summaryStatus === 'queued' || meeting.summaryStatus === 'running') return true;
    // A server-side transient can become ready after the app has already
    // persisted `failed`. Revisit only bounded, cooled-down jobs so recovery is
    // automatic without polling every historical failure forever.
    return meeting.summaryStatus === 'failed'
      && !!meeting.cloudNotesJobId
      && (meeting.cloudNotesRetryCount ?? 0) < MAX_AUTOMATIC_RETRIES
      && (!meeting.cloudNotesLastPolledAt || now - meeting.cloudNotesLastPolledAt >= RETRY_COOLDOWN_MS);
  });
  for (const meeting of meetings) void runMeetingPacketGeneration(meeting.id);
  return meetings.length;
}

export async function reconcileAutoSummaryEligibility(): Promise<number> {
  const config = await getAppConfig();
  if (!config.autoSummarize || !await getMainaCloudSession()) return 0;
  const meetings = (await listMeetingsEligibleForSummaryQueue()).filter((meeting) => meeting.status === 'transcribed' && meeting.summaryStatus === 'idle');
  for (const meeting of meetings) await maybeQueueMeetingPacket(meeting.id);
  if (meetings.length > 0) log.info('summary', 'cloud meeting packets queued', { count: meetings.length });
  return meetings.length;
}

export async function queueEligibleMeetingPackets(): Promise<number> {
  const config = await getAppConfig();
  if (!config.autoSummarize || !await getMainaCloudSession()) return 0;
  const meetings = await listMeetingsEligibleForSummaryQueue();
  for (const meeting of meetings) await maybeQueueMeetingPacket(meeting.id);
  return meetings.length;
}
