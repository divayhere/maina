export type NativeTranscriptOutcome = {
  status: 'transcribed' | 'transcript_partial' | 'recorded';
  coverageComplete: boolean;
  error: string | null;
};

export function deriveNativeTranscriptOutcome(input: {
  hasText: boolean;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  lastError?: string | null;
}): NativeTranscriptOutcome {
  const windowCount = Math.max(0, input.windowCount);
  const completedWindows = Math.max(0, input.completedWindows);
  const failedWindows = Math.max(0, input.failedWindows);
  const coverageComplete = windowCount > 0
    && failedWindows === 0
    && completedWindows === windowCount;

  if (coverageComplete && input.hasText) {
    return { status: 'transcribed', coverageComplete: true, error: null };
  }
  if (input.hasText) {
    return {
      status: 'transcript_partial',
      coverageComplete: false,
      error: input.lastError?.trim() || 'Some audio could not be transcribed. The audio was kept for recovery.',
    };
  }
  return {
    status: 'recorded',
    coverageComplete,
    error: input.lastError?.trim() || 'Local transcription produced no text. The audio was kept for recovery.',
  };
}

export function nativeProgress(input: {
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
}): { completed: number; total: number; ratio: number | null } {
  const total = Math.max(0, input.windowCount);
  const completed = Math.min(
    total,
    Math.max(0, input.completedWindows) + Math.max(0, input.failedWindows),
  );
  return { completed, total, ratio: total > 0 ? completed / total : null };
}
