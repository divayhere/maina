import { describe, expect, it } from 'vitest';

import {
  canApplyIdleCaptureMetrics,
  hasCompleteNativeTranscript,
  terminalNativeMeetingRepair,
} from './nativeCaptureReconciliation';

const complete = {
  status: 'summarized',
  summaryStatus: 'ready',
  nativePostprocessRunId: 'run-1',
  transcriptionWindowCount: 12,
  transcriptionCompletedWindows: 12,
  transcriptionFailedWindows: 0,
  audioUri: null,
  durationMs: 357_000,
  audioDurationMs: 149_000,
  captureEndedAt: 357_000,
  startedAt: 0,
  hasTranscriptText: true,
};

describe('native capture terminal reconciliation', () => {
  it('recognizes a completed native transcript after audio cleanup', () => {
    expect(hasCompleteNativeTranscript(complete)).toBe(true);
    expect(canApplyIdleCaptureMetrics({ meeting: complete, finalizedChunkCount: 0 })).toBe(false);
  });

  it('repairs only the false interrupted state from deleted completed audio', () => {
    expect(terminalNativeMeetingRepair({ ...complete, status: 'interrupted' })).toEqual({
      status: 'summarized',
      durationMs: 149_000,
      captureEndedAt: 149_000,
      lastError: null,
    });
  });

  it('does not hide a genuine incomplete recording', () => {
    expect(terminalNativeMeetingRepair({
      ...complete,
      status: 'interrupted',
      transcriptionCompletedWindows: 10,
      transcriptionFailedWindows: 2,
    })).toBeNull();
  });

  it('repairs a stale transcribing label only after the transcript is durable', () => {
    expect(terminalNativeMeetingRepair({ ...complete, status: 'transcribing', audioUri: '/audio' })).toEqual({
      status: 'summarized',
      durationMs: 149_000,
      captureEndedAt: 149_000,
      lastError: null,
    });
    expect(terminalNativeMeetingRepair({
      ...complete,
      status: 'transcribing',
      hasTranscriptText: false,
    })).toBeNull();
  });
});
