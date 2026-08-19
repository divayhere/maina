import * as FileSystem from 'expo-file-system/legacy';

import { listMeetings, updateMeeting } from '@/data/meetings';
import { getAppConfig } from '@/services/config';
import { log } from '@/services/logger';

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

export async function enforceAudioRetentionPolicy(): Promise<void> {
  const config = await getAppConfig();
  const cutoff = Date.now() - (config.audioRetentionDays * 24 * 60 * 60 * 1000);
  const meetings = (await listMeetings())
    .filter((meeting) => !!meeting.audioUri && (meeting.status === 'transcribed' || meeting.status === 'summarized'))
    .sort((a, b) => a.startedAt - b.startedAt);

  const measured = await Promise.all(
    meetings.map(async (meeting) => ({
      meeting,
      bytes: meeting.audioUri ? await measurePathBytes(meeting.audioUri) : 0,
    })),
  );

  let remainingBytes = measured.reduce((sum, item) => sum + item.bytes, 0);
  const deletions = measured.filter((item) => item.meeting.startedAt <= cutoff);

  for (const item of deletions) {
    if (!item.meeting.audioUri) continue;
    await FileSystem.deleteAsync(item.meeting.audioUri, { idempotent: true }).catch(() => {});
    await updateMeeting(item.meeting.id, { audioUri: null });
    remainingBytes -= item.bytes;
  }

  if (remainingBytes <= config.audioRetentionMaxBytes) return;

  const remaining = measured.filter((item) => item.meeting.startedAt > cutoff && item.meeting.audioUri);
  for (const item of remaining) {
    if (remainingBytes <= config.audioRetentionMaxBytes || !item.meeting.audioUri) break;
    await FileSystem.deleteAsync(item.meeting.audioUri, { idempotent: true }).catch(() => {});
    await updateMeeting(item.meeting.id, { audioUri: null });
    remainingBytes -= item.bytes;
  }

  log.info('audio-retention', 'policy enforced', {
    retentionDays: config.audioRetentionDays,
    maxBytes: config.audioRetentionMaxBytes,
    remainingBytes: Math.max(0, remainingBytes),
  });
}
