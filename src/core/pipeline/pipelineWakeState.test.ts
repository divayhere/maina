import { describe, expect, it } from 'vitest';

import {
  completeWakeClaim,
  decidePipelineWakeClaim,
  requestWakeGeneration,
  type PipelineWakeSnapshot,
} from './pipelineWakeState';

const idle = (): PipelineWakeSnapshot => ({
  generation: 0,
  enqueueRequired: false,
  connectivityEpoch: 0,
  activeAttemptToken: null,
  activeAttemptGeneration: null,
  activeAttemptLeaseUntil: null,
  lastRequestKey: null,
});

describe('durable pipeline wake generations and leases', () => {
  it('coalesces concurrent signals into one pending generation', () => {
    const first = requestWakeGeneration(idle(), { requestKey: 'network:1', connectivityRestored: true });
    const duplicate = requestWakeGeneration(first, { requestKey: 'foreground:1', connectivityRestored: false });
    expect(first).toMatchObject({ generation: 1, enqueueRequired: true, connectivityEpoch: 1, newlyRequested: true });
    expect(duplicate).toMatchObject({ generation: 1, enqueueRequired: true, connectivityEpoch: 1, newlyRequested: false });
  });

  it('opens one follow-up generation while an earlier generation is active', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(),
      generation: 3,
      activeAttemptToken: 'claim-a',
      activeAttemptGeneration: 3,
      activeAttemptLeaseUntil: 10_000,
      lastRequestKey: 'network:1',
    };
    const followUp = requestWakeGeneration(active, { requestKey: 'network:2', connectivityRestored: true });
    const duplicate = requestWakeGeneration(followUp, { requestKey: 'foreground:2', connectivityRestored: false });
    expect(followUp).toMatchObject({ generation: 4, enqueueRequired: true, newlyRequested: true });
    expect(duplicate).toMatchObject({ generation: 4, enqueueRequired: true, newlyRequested: false });
  });

  it('opens a follow-up generation for the same durable key while active', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(),
      generation: 3,
      activeAttemptToken: 'claim-a',
      activeAttemptGeneration: 3,
      activeAttemptLeaseUntil: 10_000,
      lastRequestKey: 'native:run-a',
    };
    expect(requestWakeGeneration(active, {
      requestKey: 'native:run-a',
      connectivityRestored: false,
    })).toMatchObject({ generation: 4, enqueueRequired: true, newlyRequested: true });
  });

  it('reopens the same durable generation after bounded Worker failure', () => {
    const exhausted = { ...idle(), generation: 8, lastRequestKey: 'native:run-a' };
    expect(requestWakeGeneration(exhausted, {
      requestKey: 'native:run-a',
      connectivityRestored: false,
    })).toMatchObject({ generation: 8, enqueueRequired: true, newlyRequested: true });
  });

  it('rejects stale generations and reclaims only expired leases', () => {
    const claimed: PipelineWakeSnapshot = {
      ...idle(),
      generation: 5,
      activeAttemptToken: 'dead-process',
      activeAttemptGeneration: 5,
      activeAttemptLeaseUntil: 2_000,
    };
    expect(decidePipelineWakeClaim(claimed, 4, 3_000).status).toBe('obsolete');
    expect(decidePipelineWakeClaim(claimed, 5, 1_999).status).toBe('busy');
    expect(decidePipelineWakeClaim(claimed, 5, 2_000).status).toBe('reclaimed');
  });

  it('preserves a follow-up signal on success and requeues failure exactly once', () => {
    const active = {
      ...idle(),
      generation: 2,
      enqueueRequired: true,
      activeAttemptToken: 'claim-b',
      activeAttemptGeneration: 1,
      activeAttemptLeaseUntil: 5_000,
    };
    expect(completeWakeClaim(active, { tokenMatches: true, succeeded: true }))
      .toMatchObject({ enqueueRequired: true, activeAttemptToken: null });
    expect(completeWakeClaim({ ...active, enqueueRequired: false }, { tokenMatches: true, succeeded: false }))
      .toMatchObject({ enqueueRequired: true, activeAttemptToken: null });
    expect(completeWakeClaim(active, { tokenMatches: false, succeeded: false })).toEqual(active);
  });

  it('recovers every process-death boundary without parallel claims', () => {
    const requested = requestWakeGeneration(idle(), {
      requestKey: 'network:epoch-1',
      connectivityRestored: true,
    });
    // Death before claim leaves ordinary pending work.
    expect(decidePipelineWakeClaim(requested, 1, 1_000).status).toBe('claimed');

    const claimed: PipelineWakeSnapshot = {
      ...requested,
      enqueueRequired: false,
      activeAttemptToken: 'dead-owner',
      activeAttemptGeneration: 1,
      activeAttemptLeaseUntil: 61_000,
    };
    // Death after claim or during any stage is busy only during the lease.
    expect(decidePipelineWakeClaim(claimed, 1, 60_999).status).toBe('busy');
    expect(decidePipelineWakeClaim(claimed, 1, 61_000).status).toBe('reclaimed');

    // Durable success before native completion leaves a retry Worker as a
    // truthful no-op; it cannot manufacture another generation.
    const completed = completeWakeClaim(claimed, { tokenMatches: true, succeeded: true });
    expect(decidePipelineWakeClaim(completed, 1, 61_001).status).toBe('no_work');
  });

  it('keeps one follow-up generation under concurrent lifecycle signals', () => {
    const active: PipelineWakeSnapshot = {
      ...idle(),
      generation: 11,
      activeAttemptToken: 'owner',
      activeAttemptGeneration: 11,
      activeAttemptLeaseUntil: 90_000,
    };
    const network = requestWakeGeneration(active, {
      requestKey: 'network:epoch-2',
      connectivityRestored: true,
    });
    const foreground = requestWakeGeneration(network, {
      requestKey: 'foreground:9',
      connectivityRestored: false,
    });
    const worker = decidePipelineWakeClaim(foreground, 12, 10_000);
    expect(foreground).toMatchObject({ generation: 12, enqueueRequired: true });
    expect(worker.status).toBe('busy');
  });
});
