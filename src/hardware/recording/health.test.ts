import { describe, expect, it } from 'vitest';

import { CaptureHealthTracker } from './health';

describe('CaptureHealthTracker', () => {
  it('measures saved audio independently from meeting wall time', () => {
    const tracker = new CaptureHealthTracker();
    tracker.requestSegment(0);
    tracker.audioStarted(0, 1_000);
    tracker.audioEnded(0, 11_000, true);

    expect(tracker.snapshot()).toMatchObject({
      expectedSegments: 1,
      closedSegments: 1,
      failedSegments: 0,
      audioDurationMs: 10_000,
    });
  });

  it('measures capture gaps and recognizer downtime separately', () => {
    const tracker = new CaptureHealthTracker();
    tracker.requestSegment(0);
    tracker.audioStarted(0, 0);
    tracker.captureUnavailable(10_000);
    tracker.recognizerEnded(10_100);
    tracker.requestSegment(1);
    tracker.audioStarted(1, 10_700);
    tracker.recognizerStarted(10_900);

    expect(tracker.snapshot()).toMatchObject({
      measuredGapMs: 700,
      largestGapMs: 700,
      recognizerDowntimeMs: 800,
    });
  });

  it('does not invent duration for a missing audio file', () => {
    const tracker = new CaptureHealthTracker();
    tracker.requestSegment(0);
    tracker.audioStarted(0, 5_000);
    tracker.audioEnded(0, 15_000, false);

    expect(tracker.snapshot()).toMatchObject({
      expectedSegments: 1,
      closedSegments: 0,
      failedSegments: 1,
      audioDurationMs: 0,
    });
  });
});
