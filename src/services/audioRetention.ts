import * as FileSystem from 'expo-file-system/legacy';

import { listMeetings, updateMeeting } from '@/data/meetings';
import { getAppConfig } from '@/services/config';
import { deleteNativeCaptureDirectory } from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { planAudioRetention } from '@/services/audioRetentionCore';

let retentionInFlight: Promise<void> | null = null;

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
    if ((item.meeting.audioCleanupNextRetryAt ?? 0) > Date.now()) continue;
    await updateMeeting(item.meeting.id, { audioCleanupState: 'pending' });
    const nativeDeleted = await deleteNativeCaptureDirectory(item.meeting.audioUri).catch(() => false);
    const expoDeleted = nativeDeleted
      ? true
      : await FileSystem.deleteAsync(item.meeting.audioUri, { idempotent: true })
        .then(() => true)
        .catch(() => false);
    if (!expoDeleted) {
      const retryCount = Math.max(0, item.meeting.audioCleanupRetryCount ?? 0) + 1;
      const retryDelayMs = Math.min(3 * 60 * 60_000, 15 * 60_000 * (2 ** Math.min(3, retryCount - 1)));
      await updateMeeting(item.meeting.id, {
        audioCleanupState: 'retryable',
        audioCleanupRetryCount: retryCount,
        audioCleanupNextRetryAt: Date.now() + retryDelayMs,
      });
      log.warn('audio-retention', 'audio deletion was not confirmed; keeping database pointer', {
        meetingId: item.meeting.id,
        retryCount,
      });
      continue;
    }
    await updateMeeting(item.meeting.id, {
      audioUri: null,
      audioCleanupState: 'complete',
      audioCleanupRetryCount: 0,
      audioCleanupNextRetryAt: null,
      ...(expired.has(item.meeting.id)
        ? {
            status: 'audio_expired_incomplete',
            lastError: 'Recovery audio reached the seven-day or 1 GB retention limit. Saved transcript text was kept.',
          }
        : {}),
    });
  }

  log.info('audio-retention', 'policy enforced', {
    retentionDays: config.audioRetentionDays,
    maxBytes: config.audioRetentionMaxBytes,
    deletedMeetings: decision.deleteIds.length,
    expiredIncompleteMeetings: decision.expiredIncompleteIds.length,
    remainingBytes: decision.projectedBytes,
  });
}

/** Coalesces startup, foreground and native-completion retention signals. */
export function enforceAudioRetentionPolicy(): Promise<void> {
  if (retentionInFlight) return retentionInFlight;
  const task = enforceAudioRetentionPolicyInternal().finally(() => {
    if (retentionInFlight === task) retentionInFlight = null;
  });
  retentionInFlight = task;
  return task;
}
