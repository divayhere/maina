import { describe, expect, it } from 'vitest';

import { buildRecordingCheckpoint, completedCaptureDurationRepair } from './checkpoint';

describe('recording checkpoint ownership', () => {
  it('does not let suspended React time overwrite native duration', () => {
    expect(buildRecordingCheckpoint({
      captureEngine: 'native-qwen',
      now: 262_000,
      startedAt: 0,
      pausedDurationMs: 0,
      segmentCount: 1,
      language: 'auto',
      restartCount: 0,
    })).toEqual({
      segmentCount: 1,
      language: 'auto',
      restartCount: 0,
    });
  });

  it('keeps wall-clock checkpoints for the legacy recorder', () => {
    expect(buildRecordingCheckpoint({
      captureEngine: 'legacy-speech',
      now: 42_000,
      startedAt: 5_000,
      pausedDurationMs: 2_000,
      segmentCount: 2,
      language: 'en-IN',
      restartCount: 1,
    }).durationMs).toBe(35_000);
  });

  it('repairs finalized meetings whose duration grew until app reopen', () => {
    expect(completedCaptureDurationRepair({
      status: 'summarized',
      durationMs: 262_000,
      audioDurationMs: 36_000,
    })).toBe(36_000);
  });

  it('does not rewrite live or already accurate durations', () => {
    expect(completedCaptureDurationRepair({
      status: 'recording',
      durationMs: 262_000,
      audioDurationMs: 36_000,
    })).toBeNull();
    expect(completedCaptureDurationRepair({
      status: 'transcribed',
      durationMs: 35_500,
      audioDurationMs: 36_000,
    })).toBeNull();
  });
});
