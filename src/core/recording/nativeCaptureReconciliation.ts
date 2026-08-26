export type NativeCaptureTerminalMeeting = {
  status: string;
  summaryStatus: string;
  nativePostprocessRunId?: string | null;
  transcriptionWindowCount: number;
  transcriptionCompletedWindows: number;
  transcriptionFailedWindows: number;
  audioUri?: string | null;
  durationMs: number;
  audioDurationMs: number;
  captureEndedAt?: number | null;
  startedAt: number;
};

/**
 * A complete native ASR run is durable even after the raw WAV directory is
 * intentionally removed. UI lifecycle reconciliation must never reinterpret
 * that expected cleanup as a failed recording.
 */
export function hasCompleteNativeTranscript(meeting: NativeCaptureTerminalMeeting): boolean {
  return !!meeting.nativePostprocessRunId
    && meeting.transcriptionWindowCount > 0
    && meeting.transcriptionFailedWindows === 0
    && meeting.transcriptionCompletedWindows === meeting.transcriptionWindowCount;
}

export function shouldPreserveTerminalNativeMeeting(meeting: NativeCaptureTerminalMeeting): boolean {
  return hasCompleteNativeTranscript(meeting)
    && (meeting.status === 'transcribed' || meeting.status === 'summarizing' || meeting.status === 'summarized');
}

/**
 * Repairs the exact legacy corruption caused by a completed run being revisited
 * after its disposable audio was deleted. Audio duration is the last durable
 * truthful duration once the native journal has been removed.
 */
export function terminalNativeMeetingRepair(meeting: NativeCaptureTerminalMeeting): {
  status: 'transcribed' | 'summarized';
  durationMs: number;
  captureEndedAt: number;
  lastError: null;
} | null {
  if (meeting.status !== 'interrupted' || meeting.audioUri || !hasCompleteNativeTranscript(meeting)) {
    return null;
  }
  const durationMs = Math.max(0, meeting.audioDurationMs || meeting.durationMs);
  return {
    status: meeting.summaryStatus === 'ready' ? 'summarized' : 'transcribed',
    durationMs,
    captureEndedAt: meeting.startedAt + durationMs,
    lastError: null,
  };
}

/** Native idle plus no finalized chunks is ambiguous after retention cleanup. */
export function canApplyIdleCaptureMetrics(input: {
  meeting: NativeCaptureTerminalMeeting;
  finalizedChunkCount: number;
}): boolean {
  return input.finalizedChunkCount > 0 && !shouldPreserveTerminalNativeMeeting(input.meeting);
}
