import { generateMeetingPacket } from '@/core/summarization/packet';
import {
  buildTranscriptText,
  getMeeting,
  listMeetingTodos,
  listMeetingsEligibleForSummaryQueue,
  listMeetingsNeedingSummary,
  replaceMeetingTodos,
  saveMeetingPacket,
  setMeetingSummaryState,
} from '@/data/meetings';
import { getProvider } from '@/core/summarization/providers';
import { getAppConfig, getProviderSettings, saveProviderSettings, type ProviderSettings } from '@/services/config';
import { log } from '@/services/logger';
import { maybeQueueMainaKnowledgeCloudSync } from '@/services/mainaKnowledgeCloud';
import { maybeQueueMainaKnowledgeCloudPacketCorrections } from '@/services/mainaKnowledgeCloudCorrections';
import { validateProviderSettings } from '@/services/providerValidation';

const inflight = new Map<string, Promise<void>>();

function shouldRetryAfterModelRefresh(providerId: string, message: string): boolean {
  const provider = getProvider(providerId);
  if (provider?.kind !== 'gemini') return false;
  const normalized = message.toLowerCase();
  return normalized.includes('no longer available')
    || normalized.includes('not_found')
    || normalized.includes('not found')
    || (normalized.includes('models/gemini') && normalized.includes('update your code'));
}

async function maybeRefreshProviderModel(
  providerId: string,
  settings: ProviderSettings,
  message: string,
): Promise<ProviderSettings | null> {
  if (!shouldRetryAfterModelRefresh(providerId, message)) return null;
  const validation = await validateProviderSettings(providerId, settings);
  if (!validation.ok || !validation.resolvedModel) return null;
  if (validation.resolvedModel === settings.model) return settings;
  const next = await saveProviderSettings(providerId, {
    ...settings,
    model: validation.resolvedModel,
    customBaseUrl: validation.normalizedBaseUrl ?? settings.customBaseUrl,
  });
  log.info('summary', 'provider model refreshed after packet failure', {
    providerId,
    previousModel: settings.model,
    nextModel: next.model,
  });
  return next;
}

async function generateForMeeting(meetingId: string): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  const appConfig = await getAppConfig();
  let providerSettings = await getProviderSettings(appConfig.providerId);
  if (!providerSettings.apiKey.trim()) {
    await setMeetingSummaryState(meetingId, 'failed', {
      providerId: appConfig.providerId,
      model: providerSettings.model,
      error: 'Add an API key in Settings to generate meeting packets.',
    });
    return;
  }
  const transcript = await buildTranscriptText(meetingId, { includeTimestamps: true });
  if (!transcript.text.trim()) {
    await setMeetingSummaryState(meetingId, 'failed', {
      providerId: appConfig.providerId,
      model: providerSettings.model,
      error: 'No transcript text was available for summary generation.',
    });
    return;
  }

  await setMeetingSummaryState(meetingId, 'running', {
    providerId: appConfig.providerId,
    model: providerSettings.model,
    error: null,
  });

  const runPacket = (settings: ProviderSettings) =>
    generateMeetingPacket({
      providerId: appConfig.providerId,
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.customBaseUrl,
      transcript: transcript.text,
      language: meeting.language ?? undefined,
      existingSummary: meeting.summary,
    });

  let packet;
  try {
    packet = await runPacket(providerSettings);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const refreshed = await maybeRefreshProviderModel(appConfig.providerId, providerSettings, message);
    if (!refreshed || refreshed.model === providerSettings.model) {
      throw cause;
    }
    providerSettings = refreshed;
    await setMeetingSummaryState(meetingId, 'running', {
      providerId: appConfig.providerId,
      model: providerSettings.model,
      error: null,
    });
    packet = await runPacket(providerSettings);
  }

  await saveMeetingPacket({
    meetingId,
    title: packet.title,
    summary: packet.summary,
    decisions: packet.decisions,
    openQuestions: packet.openQuestions,
    providerId: packet.providerId,
    model: packet.model,
    summarizedAt: Date.now(),
  });
  await replaceMeetingTodos(
    meetingId,
    packet.todos.map((todo) => ({
      text: todo.text,
      sourceQuote: todo.sourceQuote,
      sourceSpeakerId: todo.sourceSpeakerId ?? null,
      sourceTimestamp: todo.sourceTimestamp ?? null,
      origin: 'ai',
    })),
  );
  const currentTodos = await listMeetingTodos(meetingId);
  await maybeQueueMainaKnowledgeCloudPacketCorrections({
    meetingId,
    packet: {
      title: packet.title,
      summary: packet.summary,
      decisions: packet.decisions,
      todos: currentTodos.map((todo) => todo.text),
      openQuestions: packet.openQuestions,
    },
    providerId: packet.providerId,
    model: packet.model,
  }).catch((cause) => {
    // Cloud versioning is always secondary to the local meeting packet. A
    // queue/network defect must never turn successfully saved notes into a
    // local summary failure.
    log.warn('maina-cloud-correction', 'could not queue regenerated meeting knowledge', {
      meetingId,
      err: String(cause),
    });
  });
  log.info('summary', 'meeting packet generated', {
    meetingId,
    providerId: packet.providerId,
    model: packet.model,
    decisions: packet.decisions.length,
    todos: packet.todos.length,
    questions: packet.openQuestions.length,
  });
}

export function runMeetingPacketGeneration(meetingId: string): Promise<void> {
  const existing = inflight.get(meetingId);
  if (existing) return existing;
  const task = generateForMeeting(meetingId)
    .catch(async (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      log.warn('summary', 'meeting packet generation failed', { meetingId, err: message });
      await setMeetingSummaryState(meetingId, 'failed', { error: message }).catch(() => {});
    })
    .finally(() => {
      void maybeQueueMainaKnowledgeCloudSync(meetingId).catch((cause) => {
        log.warn('maina-cloud', 'cloud sync queue after meeting packet generation failed', {
          meetingId,
          err: String(cause),
        });
      });
      inflight.delete(meetingId);
    });
  inflight.set(meetingId, task);
  return task;
}

export async function maybeQueueMeetingPacket(meetingId: string): Promise<void> {
  const config = await getAppConfig();
  if (!config.autoSummarize) return;
  const meeting = await getMeeting(meetingId);
  if (!meeting) return;
  if (!(meeting.status === 'transcribed' || meeting.status === 'summarizing' || meeting.status === 'summarized')) return;
  await setMeetingSummaryState(meetingId, 'queued').catch(() => {});
  void runMeetingPacketGeneration(meetingId);
}

export async function reconcilePendingMeetingPackets(): Promise<void> {
  const meetings = await listMeetingsNeedingSummary();
  for (const meeting of meetings) {
    void runMeetingPacketGeneration(meeting.id);
  }
}

export async function reconcileAutoSummaryEligibility(): Promise<number> {
  const config = await getAppConfig();
  if (!config.autoSummarize) return 0;
  const meetings = (await listMeetingsEligibleForSummaryQueue()).filter(
    (meeting) => meeting.status === 'transcribed' && meeting.summaryStatus === 'idle',
  );
  for (const meeting of meetings) {
    await setMeetingSummaryState(meeting.id, 'queued').catch(() => {});
    void runMeetingPacketGeneration(meeting.id);
  }
  if (meetings.length > 0) {
    log.info('summary', 'newly transcribed meeting packets queued', { count: meetings.length });
  }
  return meetings.length;
}

export async function queueEligibleMeetingPackets(): Promise<number> {
  const config = await getAppConfig();
  if (!config.autoSummarize) return 0;
  const meetings = await listMeetingsEligibleForSummaryQueue();
  for (const meeting of meetings) {
    await setMeetingSummaryState(meeting.id, 'queued').catch(() => {});
    void runMeetingPacketGeneration(meeting.id);
  }
  log.info('summary', 'eligible meeting packets queued', { count: meetings.length });
  return meetings.length;
}
