import { describe, expect, it } from 'vitest';

import { planAudioRetention } from './audioRetentionCore';

const DAY = 24 * 60 * 60 * 1000;

describe('audio retention policy', () => {
  it('deletes completed audio immediately but preserves active readers', () => {
    const result = planAudioRetention({
      now: 10 * DAY,
      retentionDays: 7,
      maxBytes: 1_000,
      items: [
        { id: 'done', startedAt: 9 * DAY, status: 'transcribed', bytes: 400 },
        { id: 'recording', startedAt: 0, status: 'recording', bytes: 900 },
        { id: 'asr', startedAt: 0, status: 'transcribing', bytes: 900 },
      ],
    });
    expect(result.deleteIds).toEqual(['done']);
    expect(result.expiredIncompleteIds).toEqual([]);
  });

  it('expires recoverable audio after seven days', () => {
    const result = planAudioRetention({
      now: 10 * DAY,
      retentionDays: 7,
      maxBytes: 10_000,
      items: [
        { id: 'old-partial', startedAt: 2 * DAY, status: 'transcript_partial', bytes: 400 },
        { id: 'new-partial', startedAt: 9 * DAY, status: 'transcript_partial', bytes: 400 },
      ],
    });
    expect(result.deleteIds).toEqual(['old-partial']);
    expect(result.expiredIncompleteIds).toEqual(['old-partial']);
  });

  it('uses oldest recoverable audio to return under the one-gigabyte cap', () => {
    const result = planAudioRetention({
      now: 10 * DAY,
      retentionDays: 7,
      maxBytes: 1_000,
      items: [
        { id: 'oldest', startedAt: 8 * DAY, status: 'recorded', bytes: 700 },
        { id: 'newest', startedAt: 9 * DAY, status: 'transcript_partial', bytes: 700 },
      ],
    });
    expect(result.deleteIds).toEqual(['oldest']);
    expect(result.projectedBytes).toBe(700);
  });
});
