import { describe, expect, it } from 'vitest';

import { planAsrWindows, removeExactTextOverlap } from './windowing';

describe('ASR window planning', () => {
  it('covers the complete source with bounded overlapping windows', () => {
    expect(planAsrWindows(60_000, 25_000, 1_000)).toEqual([
      { startMs: 0, endMs: 25_000, overlapBeforeMs: 0 },
      { startMs: 24_000, endMs: 49_000, overlapBeforeMs: 1_000 },
      { startMs: 48_000, endMs: 60_000, overlapBeforeMs: 1_000 },
    ]);
  });

  it('keeps a short clip as one complete window', () => {
    expect(planAsrWindows(3_250)).toEqual([{ startMs: 0, endMs: 3_250, overlapBeforeMs: 0 }]);
  });

  it('folds a tiny tail into the preceding bounded window', () => {
    expect(planAsrWindows(26_119)).toEqual([{ startMs: 0, endMs: 26_119, overlapBeforeMs: 0 }]);
  });

  it('rejects overlap settings that could loop forever', () => {
    expect(() => planAsrWindows(30_000, 10_000, 10_000)).toThrow();
  });
});

describe('ASR overlap stitching', () => {
  it('removes an exact duplicated Hindi/English boundary', () => {
    expect(removeExactTextOverlap(
      'हमें Vikas से discuss करना है',
      'Vikas से discuss करना है tomorrow morning',
    )).toBe('tomorrow morning');
  });

  it('does not delete a single legitimately repeated word', () => {
    expect(removeExactTextOverlap('send it to Rahul', 'Rahul will review it')).toBe('Rahul will review it');
  });
});
