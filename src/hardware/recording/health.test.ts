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

  it('does not report an intentional pause as capture downtime', () => {
    const tracker = new CaptureHealthTracker();
    tracker.audioStarted(0, 1_000);
    tracker.pauseStarted(11_000);
    tracker.audioEnded(0, 11_100, true);
    tracker.captureUnavailable(11_100);
    tracker.recognizerEnded(11_100);
    tracker.pauseEnded(31_000);
    tracker.audioStarted(1, 31_200);
    tracker.recognizerStarted(31_300);

    expect(tracker.snapshot(40_000)).toMatchObject({
      pausedDurationMs: 20_000,
      measuredGapMs: 0,
      recognizerDowntimeMs: 0,
    });
  });
});
