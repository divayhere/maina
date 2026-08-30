import { describe, expect, it } from 'vitest';

import {
  completeWakeClaim,
  decidePipelineWakeClaim,
  generationNeedingNativeSchedule,
  markNativeScheduleOutcome,
  persistDeferredWakeSignal,
  persistWakeSignal,
  type PipelineWakeSnapshot,
} from './pipelineWakeState';

const idle = (): PipelineWakeSnapshot => ({
  signalSequence: 0,
  requestedGeneration: 0,
  completedGeneration: 0,
  currentGeneration: null,
  currentRetryNotBeforeAt: null,
  pendingGeneration: null,
  pendingNotBeforeAt: null,
  enqueueRequired: false,
  connectivityEpoch: 0,
  lastConnected: null,
  requiresNetwork: false,
  activeAttemptToken: null,
  activeAttemptGeneration: null,
  activeAttemptLeaseUntil: null,
  nativeScheduleState: 'idle',
  nativeScheduleAttempts: 0,
  nativeScheduleRevision: 0,
});

describe('durable pipeline current and successor generations', () => {
  it('coalesces pending signals while preserving their durable sequence', () => {
    const first = persistWakeSignal(idle(), { connected: false, requiresNetwork: true }, 100);
    const duplicate = persistWakeSignal(first, { connected: false, requiresNetwork: true }, 101);
    expect(first).toMatchObject({
      signalSequence: 1,
      requestedGeneration: 1,
      currentGeneration: 1,
      currentRetryNotBeforeAt: 100,
      openedGeneration: true,
    });
    expect(duplicate).toMatchObject({
      signalSequence: 2,
      requestedGeneration: 1,
      currentGeneration: 1,
      openedGeneration: false,
    });
  });

  it('persists reconnect during active N as exactly one pending N+1 tuple', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 3, completedGeneration: 2,
      currentGeneration: 3, currentRetryNotBeforeAt: null, lastConnected: false,
      activeAttemptToken: 'owner-n', activeAttemptGeneration: 3, activeAttemptLeaseUntil: 60_000,
      nativeScheduleState: 'claimed',
    };
    const reconnect = persistWakeSignal(active, { connected: true, requiresNetwork: true }, 1_000);
    const foreground = persistWakeSignal(reconnect, { requiresNetwork: false }, 1_001);
    expect(reconnect).toMatchObject({
      requestedGeneration: 4,
      pendingGeneration: 4,
      pendingNotBeforeAt: 1_000,
      connectivityEpoch: 1,
    });
    expect(foreground).toMatchObject({
      requestedGeneration: 4,
      pendingGeneration: 4,
      pendingNotBeforeAt: 1_000,
      signalSequence: 2,
    });
    expect(generationNeedingNativeSchedule(foreground, 1_000)).toBeNull();
  });

  it('promotes N+1 with its exact due only after N succeeds', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 4, completedGeneration: 2,
      currentGeneration: 3, pendingGeneration: 4, pendingNotBeforeAt: 9_000,
      enqueueRequired: true, activeAttemptToken: 'owner-n', activeAttemptGeneration: 3,
      activeAttemptLeaseUntil: 60_000, nativeScheduleState: 'claimed',
    };
    const completed = completeWakeClaim(active, {
      tokenMatches: true,
      succeeded: true,
      now: 1_000,
    });
    expect(completed).toMatchObject({
      completedGeneration: 3,
      currentGeneration: 4,
      currentRetryNotBeforeAt: 9_000,
      pendingGeneration: null,
      enqueueRequired: true,
    });
    expect(generationNeedingNativeSchedule(completed, 1_000)).toEqual({
      generation: 4,
      notBeforeAt: 9_000,
      scheduleRevision: 1,
    });
  });

  it('reclaims expired N immediately without discarding delayed successor N+1', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 6, completedGeneration: 4,
      currentGeneration: 5, pendingGeneration: 6, pendingNotBeforeAt: 50_000,
      enqueueRequired: true, activeAttemptToken: 'dead-owner', activeAttemptGeneration: 5,
      activeAttemptLeaseUntil: 2_000,
    };
    const retry = persistDeferredWakeSignal(active, {
      requiresNetwork: true,
      notBeforeAt: 90_000,
    }, 2_000);
    expect(retry).toMatchObject({
      currentGeneration: 5,
      currentRetryNotBeforeAt: 2_000,
      pendingGeneration: 6,
      pendingNotBeforeAt: 50_000,
    });
    expect(decidePipelineWakeClaim(retry, 6, 2_000).status).toBe('busy');
    expect(decidePipelineWakeClaim(retry, 5, 2_000).status).toBe('reclaimed');
    expect(generationNeedingNativeSchedule(retry, 2_000)).toEqual({
      generation: 5,
      notBeforeAt: 2_000,
      scheduleRevision: 1,
    });
  });

  it('keeps failed N retryable and preserves its exact successor', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 2, currentGeneration: 1,
      pendingGeneration: 2, pendingNotBeforeAt: 80_000,
      activeAttemptToken: 'owner', activeAttemptGeneration: 1,
      activeAttemptLeaseUntil: 20_000,
    };
    const failed = completeWakeClaim(active, {
      tokenMatches: true,
      succeeded: false,
      now: 10_000,
      failureRetryAt: 25_000,
    });
    expect(failed).toMatchObject({
      currentGeneration: 1,
      currentRetryNotBeforeAt: 25_000,
      pendingGeneration: 2,
      pendingNotBeforeAt: 80_000,
      activeAttemptToken: null,
    });
  });

  it('coalesces two delayed successor signals to the earliest due without changing identity', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 1, currentGeneration: 1,
      activeAttemptToken: 'owner', activeAttemptGeneration: 1,
      activeAttemptLeaseUntil: 20_000,
    };
    const later = persistDeferredWakeSignal(active, {
      requiresNetwork: true,
      notBeforeAt: 90_000,
    }, 1_000);
    const earlier = persistDeferredWakeSignal(later, {
      requiresNetwork: true,
      notBeforeAt: 40_000,
    }, 1_001);
    expect(earlier).toMatchObject({
      requestedGeneration: 2,
      pendingGeneration: 2,
      pendingNotBeforeAt: 40_000,
    });
  });

  it('makes stale workers true no-ops after durable completion', () => {
    const completed = { ...idle(), requestedGeneration: 7, completedGeneration: 7 };
    expect(decidePipelineWakeClaim(completed, 7, 10_000).status).toBe('no_work');
    expect(generationNeedingNativeSchedule(completed, 10_000)).toBeNull();
  });

  it('lets a genuine signal reopen bounded native scheduling after max attempts', () => {
    const pending = persistWakeSignal(idle(), { connected: true, requiresNetwork: true }, 100);
    const failed = markNativeScheduleOutcome(pending, {
      generation: 1,
      scheduleRevision: 1,
      outcome: 'max_attempts',
    });
    expect(failed).toMatchObject({ nativeScheduleState: 'max_attempts', enqueueRequired: true });
    const reopened = persistWakeSignal(failed, { connected: true, requiresNetwork: true }, 101);
    expect(reopened).toMatchObject({
      requestedGeneration: 1,
      nativeScheduleState: 'pending',
      nativeScheduleAttempts: 0,
    });
  });

  it('keeps due work visible to the periodic direct drain after native max attempts', () => {
    const maxed: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 1, currentGeneration: 1,
      currentRetryNotBeforeAt: 500, enqueueRequired: true,
      nativeScheduleState: 'max_attempts', nativeScheduleAttempts: 5,
    };
    expect(generationNeedingNativeSchedule(maxed, 1_000)).toEqual({
      generation: 1,
      notBeforeAt: 500,
      scheduleRevision: 0,
    });
  });

  it('does not clear a claim when a stale completion token arrives', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 1, currentGeneration: 1,
      activeAttemptToken: 'current', activeAttemptGeneration: 1, activeAttemptLeaseUntil: 20_000,
    };
    expect(completeWakeClaim(active, {
      tokenMatches: false,
      succeeded: true,
      now: 1_000,
    })).toEqual(active);
  });
});
