import { describe, expect, it } from 'vitest';

import { normalizeNativeBlockTimeline } from './nativeBlockTiming';

describe('normalizeNativeBlockTimeline', () => {
  it('keeps a valid native epoch timeline unchanged', () => {
    const blocks = [{ startedAt: 1_700_000_000_000, endedAt: 1_700_000_005_000 }];
    expect(normalizeNativeBlockTimeline(blocks, 1_700_000_000_000, 10_000)).toEqual(blocks);
  });

  it('reanchors an epoch-zero/retry-time timeline to the meeting', () => {
    expect(normalizeNativeBlockTimeline(
      [
        { startedAt: 1_000, endedAt: 6_000 },
        { startedAt: 14_000, endedAt: 20_000 },
      ],
      1_700_000_000_000,
      30_000,
    )).toEqual([
      { startedAt: 1_700_000_000_000, endedAt: 1_700_000_005_000 },
      { startedAt: 1_700_000_013_000, endedAt: 1_700_000_019_000 },
    ]);
  });
});
