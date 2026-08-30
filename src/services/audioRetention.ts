import * as FileSystem from 'expo-file-system/legacy';

import { getMeeting, listMeetings, updateMeeting, type Meeting } from '@/data/meetings';
import { getAppConfig } from '@/services/config';
import {
  deleteNativeCaptureDirectory,
  getPcmWavDurationsMs,
  inspectNativeCaptureDirectory,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { planAudioRetention } from '@/services/audioRetentionCore';
import { notifyMeetingPipelineChanged } from '@/services/meetingPipelineSignals';

let retentionInFlight: Promise<void> | null = null;
const meetingCleanupInFlight = new Map<string, Promise<boolean>>();
let lastFullScanAt = 0;

async function measurePathBytes(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false } as const));
  if (!info.exists) return 0;
  if ('isDirectory' in info && info.isDirectory) {
    const entries = await FileSystem.readDirectoryAsync(uri).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const nextUri = uri.endsWith('/') ? `${uri}${entry}` : `${uri}/${entry}`;
      total += await measurePathBytes(nextUri);
    }
    return total;
  }
  return 'size' in info && typeof info.size === 'number' ? info.size : 0;
}

async function deleteAndVerifyMeetingAudio(meeting: Meeting, expiredIncomplete: boolean): Promise<boolean> {
  if (!meeting.audioUri) return true;
  if ((meeting.audioCleanupNextRetryAt ?? 0) > Date.now()) return false;
  // Capture duration must come from durable PCM evidence, never wall elapsed
  // time. Older rows can lack audio_duration_ms, so measure finalized WAVs
  // before deleting their directory.
  let measuredAudioDurationMs = Math.max(0, meeting.audioDurationMs ?? 0);
  if (measuredAudioDurationMs === 0) {
    const inspection = await inspectNativeCaptureDirectory(meeting.audioUri, false).catch(() => null);
    if (inspection?.finalizedUris.length) {
      const durations: Record<string, number | null> = await getPcmWavDurationsMs(
        inspection.finalizedUris,
      ).catch(() => ({}));
      measuredAudioDurationMs = inspection.finalizedUris.reduce(
        (sum, uri) => sum + Math.max(0, durations[uri] ?? 0),
        0,
      );
    }
  }
  await updateMeeting(meeting.id, { audioCleanupState: 'pending' });
  const nativeDeleted = await deleteNativeCaptureDirectory(meeting.audioUri).catch(() => false);
  if (!nativeDeleted) {
    await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true }).catch(() => {});
  }
  const verification = await FileSystem.getInfoAsync(meeting.audioUri)
    .catch(() => ({ exists: true } as const));
  if (verification.exists) {
    const retryCount = Math.max(0, meeting.audioCleanupRetryCount ?? 0) + 1;
    const retryDelayMs = Math.min(3 * 60 * 60_000, 15 * 60_000 * (2 ** Math.min(3, retryCount - 1)));
    await updateMeeting(meeting.id, {
      audioCleanupState: 'retryable',
      audioCleanupRetryCount: retryCount,
      audioCleanupNextRetryAt: Date.now() + retryDelayMs,
    });
    notifyMeetingPipelineChanged(meeting.id);
    log.warn('audio-retention', 'audio deletion was not confirmed; keeping database pointer', {
      meetingId: meeting.id,
      retryCount,
    });
    return false;
  }
  await updateMeeting(meeting.id, {
    ...(measuredAudioDurationMs > 0
      ? {
          durationMs: Math.max(0, meeting.durationMs, measuredAudioDurationMs),
          audioDurationMs: measuredAudioDurationMs,
        }
      : {}),
    audioUri: null,
    audioCleanupState: 'complete',
    audioCleanupRetryCount: 0,
    audioCleanupNextRetryAt: null,
    ...(expiredIncomplete
      ? {
          status: 'audio_expired_incomplete',
          lastError: 'Recovery audio reached the seven-day or 1 GB retention limit. Saved transcript text was kept.',
        }
      : {}),
  });
  notifyMeetingPipelineChanged(meeting.id);
  return true;
}

/** Terminal transcript cleanup is per-meeting and never waits for cloud notes. */
export function cleanupTerminalMeetingAudio(meetingId: string): Promise<boolean> {
  const existing = meetingCleanupInFlight.get(meetingId);
  if (existing) return existing;
  let task: Promise<boolean>;
  task = getMeeting(meetingId)
    .then((meeting) => {
      if (!meeting?.audioUri) return true;
      const verifiedNoSpeech = meeting.status === 'recorded'
        && meeting.transcriptionWindowCount > 0
        && meeting.transcriptionCompletedWindows === meeting.transcriptionWindowCount
        && meeting.transcriptionFailedWindows === 0;
      if (!verifiedNoSpeech && !['transcribed', 'summarizing', 'summarized'].includes(meeting.status)) return false;
      return deleteAndVerifyMeetingAudio(meeting, false);
    })
    .finally(() => {
      if (meetingCleanupInFlight.get(meetingId) === task) meetingCleanupInFlight.delete(meetingId);
    });
  meetingCleanupInFlight.set(meetingId, task);
  return task;
}

async function enforceAudioRetentionPolicyInternal(): Promise<void> {
  const config = await getAppConfig();
  const meetings = (await listMeetings())
    .filter((meeting) => !!meeting.audioUri)
    .sort((a, b) => a.startedAt - b.startedAt);

  const measured = await Promise.all(
    meetings.map(async (meeting) => ({
      meeting,
      bytes: meeting.audioUri ? await measurePathBytes(meeting.audioUri) : 0,
    })),
  );

  const decision = planAudioRetention({
    now: Date.now(),
    retentionDays: config.audioRetentionDays,
    maxBytes: config.audioRetentionMaxBytes,
    items: measured.map(({ meeting, bytes }) => ({
      id: meeting.id,
      startedAt: meeting.startedAt,
      status: meeting.status,
      bytes,
    })),
  });
  const expired = new Set(decision.expiredIncompleteIds);
  for (const item of measured) {
    if (!decision.deleteIds.includes(item.meeting.id) || !item.meeting.audioUri) continue;
    await deleteAndVerifyMeetingAudio(item.meeting, expired.has(item.meeting.id));
  }

  log.info('audio-retention', 'policy enforced', {
    retentionDays: config.audioRetentionDays,
    maxBytes: config.audioRetentionMaxBytes,
    deletedMeetings: decision.deleteIds.length,
    expiredIncompleteMeetings: decision.expiredIncompleteIds.length,
    remainingBytes: decision.projectedBytes,
  });
}

/** Coalesces broad fallback scans and limits routine pipeline scans to daily. */
export function enforceAudioRetentionPolicy(
  reason: 'startup' | 'pipeline' | 'daily' | 'size_pressure' | 'diagnostics' = 'pipeline',
): Promise<void> {
  if (retentionInFlight) return retentionInFlight;
  if (reason === 'pipeline' && Date.now() - lastFullScanAt < 24 * 60 * 60_000) {
    return Promise.resolve();
  }
  const task = enforceAudioRetentionPolicyInternal().finally(() => {
    lastFullScanAt = Date.now();
    if (retentionInFlight === task) retentionInFlight = null;
  });
  retentionInFlight = task;
  return task;
}
