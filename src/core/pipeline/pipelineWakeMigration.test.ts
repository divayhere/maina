import { describe, expect, it } from 'vitest';

import { normalizePipelineWakeV17 } from './pipelineWakeMigration';

describe('schema v17 wake normalization', () => {
  it('recovers the actual stale iPhone generation without creating a successor', () => {
    const migrated = normalizePipelineWakeV17({
      requestedGeneration: 3,
      completedGeneration: 2,
      nativeScheduleState: 'max_attempts',
      nativeScheduleAttempts: 5,
    }, 1_000);

    expect(migrated).toEqual({
      currentGeneration: 3,
      currentRetryNotBeforeAt: 1_000,
      pendingGeneration: null,
      pendingNotBeforeAt: null,
      enqueueRequired: true,
      nativeScheduleState: 'pending',
      nativeScheduleAttempts: 0,
      nativeScheduleRevision: 1,
    });
  });

  it('preserves an already-normalized successor tuple on restart', () => {
    const first = normalizePipelineWakeV17({
      requestedGeneration: 4,
      completedGeneration: 2,
      currentGeneration: 3,
      currentRetryNotBeforeAt: 2_000,
      pendingGeneration: 4,
      pendingNotBeforeAt: 50_000,
      nativeScheduleState: 'pending',
      nativeScheduleAttempts: 0,
      nativeScheduleRevision: 7,
    }, 10_000);
    const second = normalizePipelineWakeV17({
      requestedGeneration: 4,
      completedGeneration: 2,
      ...first,
    }, 20_000);
    expect(second).toEqual(first);
  });
});
