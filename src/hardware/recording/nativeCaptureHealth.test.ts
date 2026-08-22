import { describe, expect, it } from 'vitest';

import { isNativeCaptureStalled, NATIVE_CAPTURE_STALL_MS } from './nativeCaptureHealth';

describe('isNativeCaptureStalled', () => {
  it('only reports a stall for recording sessions whose native progress is stale', () => {
    expect(isNativeCaptureStalled({ state: 'recording', lastProgressAtMs: 1_000 }, 1_000 + NATIVE_CAPTURE_STALL_MS - 1)).toBe(false);
    expect(isNativeCaptureStalled({ state: 'recording', lastProgressAtMs: 1_000 }, 1_000 + NATIVE_CAPTURE_STALL_MS)).toBe(true);
  });

  it('ignores missing progress timestamps and non-recording states', () => {
    expect(isNativeCaptureStalled({ state: 'paused', lastProgressAtMs: 1_000 }, 100_000)).toBe(false);
    expect(isNativeCaptureStalled({ state: 'recording' }, 100_000)).toBe(false);
    expect(isNativeCaptureStalled(null, 100_000)).toBe(false);
  });
});
