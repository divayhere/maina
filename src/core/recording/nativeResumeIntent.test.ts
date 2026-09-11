import { describe, expect, it } from 'vitest';

import { NativeResumeIntentLatch } from './nativeResumeIntent';

const pendingPause = {
  active: true,
  paused: true,
  saving: false,
  controlBusy: true,
  pauseCommandPending: true,
};

describe('NativeResumeIntentLatch', () => {
  it('delivers exactly one resume after the visible-Paused bridge window', () => {
    const latch = new NativeResumeIntentLatch();
    let resumeCommands = 0;

    expect(latch.requestDuringPauseBridge(pendingPause)).toBe(true);
    expect(latch.requestDuringPauseBridge(pendingPause)).toBe(true);

    const delivered = latch.takeAfterPauseBridge({
      ...pendingPause,
      controlBusy: false,
      pauseCommandPending: false,
    });
    if (delivered) resumeCommands += 1;
    if (latch.takeAfterPauseBridge({
      ...pendingPause,
      controlBusy: false,
      pauseCommandPending: false,
    })) resumeCommands += 1;

    expect(delivered).toBe(true);
    expect(resumeCommands).toBe(1);
  });

  it('does not queue outside the native pause bridge', () => {
    const latch = new NativeResumeIntentLatch();
    expect(latch.requestDuringPauseBridge({ ...pendingPause, pauseCommandPending: false })).toBe(false);
    expect(latch.requestDuringPauseBridge({ ...pendingPause, controlBusy: false })).toBe(false);
    expect(latch.requestDuringPauseBridge({ ...pendingPause, active: false })).toBe(false);
    expect(latch.requestDuringPauseBridge({ ...pendingPause, paused: false })).toBe(false);
    expect(latch.requestDuringPauseBridge({ ...pendingPause, saving: true })).toBe(false);
  });

  it('consumes a queued resume when terminal state wins', () => {
    const latch = new NativeResumeIntentLatch();
    expect(latch.requestDuringPauseBridge(pendingPause)).toBe(true);
    expect(latch.takeAfterPauseBridge({
      ...pendingPause,
      saving: true,
      controlBusy: false,
      pauseCommandPending: false,
    })).toBe(false);
    expect(latch.takeAfterPauseBridge({
      ...pendingPause,
      controlBusy: false,
      pauseCommandPending: false,
    })).toBe(false);
  });

  it('cancels an outstanding resume on lifecycle invalidation', () => {
    const latch = new NativeResumeIntentLatch();
    expect(latch.requestDuringPauseBridge(pendingPause)).toBe(true);
    latch.cancel();
    expect(latch.takeAfterPauseBridge({
      ...pendingPause,
      controlBusy: false,
      pauseCommandPending: false,
    })).toBe(false);
  });
});
