export interface NativeTimedBlock {
  startedAt?: number | null;
  endedAt?: number | null;
}

const EPOCH_FLOOR = 1_000_000_000_000;
const TOLERANCE_MS = 60_000;

/**
 * Native ASR blocks are offsets anchored to the service's meeting-start value.
 * Older builds could lose that bridge value, producing epoch/retry-time block
 * timestamps even though the meeting row retained the real start. Re-anchor
 * only clearly impossible timelines; preserve valid timestamps unchanged.
 */
export function normalizeNativeBlockTimeline<T extends NativeTimedBlock>(
  blocks: T[],
  meetingStartedAt: number,
  durationMs: number,
): T[] {
  if (!Number.isFinite(meetingStartedAt) || meetingStartedAt < EPOCH_FLOOR || blocks.length === 0) {
    return blocks;
  }
  const timestamps = blocks
    .map((block) => block.startedAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  const firstStartedAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
  if (firstStartedAt == null) return blocks;

  const expectedEarliest = meetingStartedAt - TOLERANCE_MS;
  const expectedLatest = meetingStartedAt + Math.max(0, durationMs) + TOLERANCE_MS;
  if (firstStartedAt >= expectedEarliest && firstStartedAt <= expectedLatest) return blocks;

  return blocks.map((block) => {
    if (!Number.isFinite(block.startedAt) || !Number.isFinite(block.endedAt)) return block;
    const startOffset = Math.max(0, block.startedAt! - firstStartedAt);
    const endOffset = Math.max(startOffset, block.endedAt! - firstStartedAt);
    return {
      ...block,
      startedAt: meetingStartedAt + startOffset,
      endedAt: meetingStartedAt + endOffset,
    };
  });
}
