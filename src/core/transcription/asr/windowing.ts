export interface AsrWindowPlan {
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
}

export const DEFAULT_ASR_WINDOW_MS = 15_000;
export const DEFAULT_ASR_OVERLAP_MS = 2_000;
export const MIN_ASR_TAIL_MS = 5_000;

/**
 * Qwen is an utterance recognizer, not a whole-meeting decoder. Keep each
 * request bounded while covering every source sample. Overlap is analysis-only:
 * the immutable capture WAV is never cut or rewritten.
 */
export function planAsrWindows(
  durationMs: number,
  windowMs = DEFAULT_ASR_WINDOW_MS,
  overlapMs = DEFAULT_ASR_OVERLAP_MS,
): AsrWindowPlan[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  if (!Number.isFinite(windowMs) || windowMs < 5_000) throw new Error('ASR window must be at least 5 seconds');
  if (!Number.isFinite(overlapMs) || overlapMs < 0 || overlapMs >= windowMs) {
    throw new Error('ASR overlap must be non-negative and shorter than the window');
  }

  const roundedDuration = Math.ceil(durationMs);
  const windows: AsrWindowPlan[] = [];
  let startMs = 0;
  while (startMs < roundedDuration) {
    let endMs = Math.min(roundedDuration, startMs + windowMs);
    // Avoid creating a tiny final decode from overlap/noise alone. Extending
    // the preceding window keeps the request under 30 seconds with Maina's
    // 25-second default and gives the recognizer useful linguistic context.
    if (roundedDuration - endMs <= MIN_ASR_TAIL_MS) endMs = roundedDuration;
    windows.push({
      startMs,
      endMs,
      overlapBeforeMs: windows.length === 0 ? 0 : Math.min(overlapMs, startMs),
    });
    if (endMs >= roundedDuration) break;
    startMs = endMs - overlapMs;
  }
  return windows;
}

const normalizeToken = (value: string) => value
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '');

/** Remove only an exact normalized suffix/prefix match created by ASR overlap. */
export function removeExactTextOverlap(previous: string, current: string, maxWords = 24): string {
  const previousWords = previous.trim().split(/\s+/).filter(Boolean);
  const currentWords = current.trim().split(/\s+/).filter(Boolean);
  const limit = Math.min(maxWords, previousWords.length, currentWords.length);

  for (let count = limit; count >= 2; count -= 1) {
    const tail = previousWords.slice(-count).map(normalizeToken);
    const head = currentWords.slice(0, count).map(normalizeToken);
    if (tail.every((word, index) => word.length > 0 && word === head[index])) {
      return currentWords.slice(count).join(' ').trim();
    }
  }
  return current.trim();
}
