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

/**
 * Native retries deliberately keep the same durable run ID so an interruption
 * cannot create a second transcript lineage. That ID alone therefore cannot
 * decide idempotency: import again only when that run has made measurable
 * progress (for example 12/13 partial windows becoming 13/13 complete).
 */
export function shouldImportNativePostProcessingResult(input: {
  persistedRunId?: string | null;
  persistedWindowCount: number;
  persistedCompletedWindows: number;
  persistedFailedWindows: number;
  incomingRunId: string;
  incomingWindowCount: number;
  incomingCompletedWindows: number;
  incomingFailedWindows: number;
}): boolean {
  if (input.persistedRunId !== input.incomingRunId) return true;
  return input.persistedWindowCount !== input.incomingWindowCount
    || input.persistedCompletedWindows !== input.incomingCompletedWindows
    || input.persistedFailedWindows !== input.incomingFailedWindows;
}

/**
 * An outbox acknowledgement can fail after the Expo database has been
 * imported. A later lifecycle write may also leave that database row in an
 * in-progress state. The durable native result is authoritative, but never
 * move a meeting backwards once notes are being generated or are complete.
 */
export function shouldRepairNativeTranscriptStatus(input: {
  persistedStatus: string;
  incomingStatus: NativeTranscriptOutcome['status'];
}): boolean {
  if (input.persistedStatus === input.incomingStatus) return false;
  return [
    'recording',
    'interrupted',
    'recorded',
    'transcribing',
    'transcript_partial',
    'audio_expired_incomplete',
  ].includes(input.persistedStatus);
}
