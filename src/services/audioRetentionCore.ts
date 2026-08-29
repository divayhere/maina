import type { MeetingStatus } from '@/data/meetings';

export type AudioRetentionItem = {
  id: string;
  startedAt: number;
  status: MeetingStatus;
  bytes: number;
};

export type AudioRetentionDecision = {
  deleteIds: string[];
  expiredIncompleteIds: string[];
  projectedBytes: number;
};

// Cloud notes are queued before retention runs. At that point the meeting is
// already `summarizing`, but its transcript is durable and the summarizer reads
// text from SQLite—not the capture files. Treat that state as complete so the
// temporary audio is removed immediately instead of waiting for another launch.
const COMPLETE_STATUSES = new Set<MeetingStatus>(['transcribed', 'summarizing', 'summarized']);
const ACTIVE_STATUSES = new Set<MeetingStatus>(['recording', 'transcribing']);

export function planAudioRetention(input: {
  items: AudioRetentionItem[];
  now: number;
  retentionDays: number;
  maxBytes: number;
}): AudioRetentionDecision {
  const cutoff = input.now - Math.max(0, input.retentionDays) * 24 * 60 * 60 * 1000;
  const ordered = [...input.items].sort((left, right) => left.startedAt - right.startedAt);
  const deleteIds = new Set<string>();
  const expiredIncompleteIds = new Set<string>();
  let projectedBytes = ordered.reduce((sum, item) => sum + Math.max(0, item.bytes), 0);

  // Completed transcript text is the durable asset. Audio is recovery material
  // and is removed immediately after the transactional import succeeds.
  for (const item of ordered) {
    if (!COMPLETE_STATUSES.has(item.status)) continue;
    deleteIds.add(item.id);
    projectedBytes -= Math.max(0, item.bytes);
  }

  // Active capture/ASR files are counted but never removed under their reader.
  const recoverable = ordered.filter(
    (item) => !deleteIds.has(item.id) && !ACTIVE_STATUSES.has(item.status),
  );
  for (const item of recoverable) {
    if (item.startedAt > cutoff) continue;
    deleteIds.add(item.id);
    expiredIncompleteIds.add(item.id);
    projectedBytes -= Math.max(0, item.bytes);
  }

  for (const item of recoverable) {
    if (projectedBytes <= Math.max(0, input.maxBytes)) break;
    if (deleteIds.has(item.id)) continue;
    deleteIds.add(item.id);
    expiredIncompleteIds.add(item.id);
    projectedBytes -= Math.max(0, item.bytes);
  }

  return {
    deleteIds: [...deleteIds],
    expiredIncompleteIds: [...expiredIncompleteIds],
    projectedBytes: Math.max(0, projectedBytes),
  };
}
