export interface RecordingCheckpointInput {
  captureEngine: 'native-qwen' | 'legacy-speech';
  now: number;
  startedAt: number;
  pausedDurationMs: number;
  segmentCount: number;
  language: string;
  restartCount: number;
}

export interface RecordingCheckpoint {
  durationMs?: number;
  segmentCount: number;
  language: string;
  restartCount: number;
}

/**
 * Native capture owns final duration because its journal and WAV headers
 * survive a suspended React process. JS wall-clock time is only authoritative
 * for the legacy screen-owned recorder.
 */
export function buildRecordingCheckpoint(input: RecordingCheckpointInput): RecordingCheckpoint {
  return {
    ...(input.captureEngine === 'legacy-speech'
      ? { durationMs: Math.max(0, input.now - input.startedAt - input.pausedDurationMs) }
      : {}),
    segmentCount: input.segmentCount,
    language: input.language,
    restartCount: input.restartCount,
  };
}

export function completedCaptureDurationRepair(input: {
  status: string;
  durationMs: number;
  audioDurationMs: number;
  toleranceMs?: number;
}): number | null {
  if (input.status === 'recording') return null;
  const canonicalDurationMs = Math.max(0, input.audioDurationMs);
  if (canonicalDurationMs <= 0) return null;
  const toleranceMs = input.toleranceMs ?? 2_000;
  return Math.abs(input.durationMs - canonicalDurationMs) > toleranceMs
    ? canonicalDurationMs
    : null;
}
