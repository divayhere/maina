import { describe, expect, it } from 'vitest';

import {
  completeWakeClaim,
  decidePipelineWakeClaim,
  generationNeedingNativeSchedule,
  markNativeScheduleOutcome,
  persistWakeSignal,
  type PipelineWakeSnapshot,
} from './pipelineWakeState';

const idle = (): PipelineWakeSnapshot => ({
  signalSequence: 0,
  requestedGeneration: 0,
  completedGeneration: 0,
  enqueueRequired: false,
  connectivityEpoch: 0,
  lastConnected: null,
  requiresNetwork: false,
  activeAttemptToken: null,
  activeAttemptGeneration: null,
  activeAttemptLeaseUntil: null,
  nativeScheduleState: 'idle',
  nativeScheduleAttempts: 0,
});

describe('durable pipeline wake generations', () => {
  it('coalesces pending signals while allocating durable signal sequences', () => {
    const first = persistWakeSignal(idle(), { connected: false, requiresNetwork: true });
    const duplicate = persistWakeSignal(first, { connected: false, requiresNetwork: true });
    expect(first).toMatchObject({ signalSequence: 1, requestedGeneration: 1, openedGeneration: true });
    expect(duplicate).toMatchObject({ signalSequence: 2, requestedGeneration: 1, openedGeneration: false });
  });

  it('persists reconnect during active N as one pending N+1', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 3, completedGeneration: 2, lastConnected: false,
      activeAttemptToken: 'owner-n', activeAttemptGeneration: 3, activeAttemptLeaseUntil: 60_000,
    };
    const reconnect = persistWakeSignal(active, { connected: true, requiresNetwork: true });
    const foreground = persistWakeSignal(reconnect, { requiresNetwork: false });
    expect(reconnect).toMatchObject({ requestedGeneration: 4, connectivityEpoch: 1, enqueueRequired: true });
    expect(foreground).toMatchObject({ requestedGeneration: 4, signalSequence: 2 });
    expect(generationNeedingNativeSchedule(foreground, 1_000)).toBeNull();
  });

  it('hands N+1 to scheduling only after N completes', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 4, completedGeneration: 2, enqueueRequired: true,
      activeAttemptToken: 'owner-n', activeAttemptGeneration: 3, activeAttemptLeaseUntil: 60_000,
    };
    const completed = completeWakeClaim(active, { tokenMatches: true, succeeded: true });
    expect(completed).toMatchObject({ completedGeneration: 3, enqueueRequired: true });
    expect(generationNeedingNativeSchedule(completed, 1_000)).toBe(4);
  });

  it('reclaims a dead owner but never runs two generations in parallel', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 6, completedGeneration: 4, enqueueRequired: true,
      activeAttemptToken: 'dead-owner', activeAttemptGeneration: 5, activeAttemptLeaseUntil: 2_000,
    };
    expect(decidePipelineWakeClaim(active, 6, 1_999).status).toBe('busy');
    expect(decidePipelineWakeClaim(active, 6, 2_000).status).toBe('busy');
    expect(decidePipelineWakeClaim(active, 5, 2_000).status).toBe('reclaimed');
    expect(generationNeedingNativeSchedule(active, 2_000)).toBe(5);
  });

  it('makes stale Workers true no-ops after durable completion', () => {
    const completed = { ...idle(), requestedGeneration: 7, completedGeneration: 7 };
    expect(decidePipelineWakeClaim(completed, 7, 10_000).status).toBe('obsolete');
    expect(generationNeedingNativeSchedule(completed, 10_000)).toBeNull();
  });

  it('keeps failed enqueue durable and lets a genuine signal reopen max attempts', () => {
    const pending = persistWakeSignal(idle(), { connected: true, requiresNetwork: true });
    const failed = markNativeScheduleOutcome(pending, { generation: 1, outcome: 'max_attempts' });
    expect(failed).toMatchObject({ nativeScheduleState: 'max_attempts', enqueueRequired: true });
    const reopened = persistWakeSignal(failed, { connected: true, requiresNetwork: true });
    expect(reopened).toMatchObject({ requestedGeneration: 1, nativeScheduleState: 'pending', nativeScheduleAttempts: 0 });
  });

  it('does not clear a claim when a stale completion token arrives', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(), requestedGeneration: 1, activeAttemptToken: 'current',
      activeAttemptGeneration: 1, activeAttemptLeaseUntil: 20_000,
    };
    expect(completeWakeClaim(active, { tokenMatches: false, succeeded: true })).toEqual(active);
  });
});
