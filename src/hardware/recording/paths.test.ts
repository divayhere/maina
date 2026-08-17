import { describe, expect, it } from 'vitest';

import { segmentIndexFromUri, segmentName } from './segment';

describe('recording paths', () => {
  it('uses sortable file names', () => {
    expect(segmentName(12)).toBe('seg-0012.wav');
  });

  it('recovers the segment index from an audioend URI', () => {
    expect(segmentIndexFromUri('file:///data/user/0/maina/seg-0042.wav')).toBe(42);
  });

  it('rejects unrelated audio paths', () => {
    expect(segmentIndexFromUri('file:///tmp/recording.wav')).toBeNull();
  });
});
