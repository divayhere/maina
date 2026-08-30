import { describe, expect, it, vi } from 'vitest';

import {
  acceptIOSContinuedProcessingDeferral,
  createIOSContinuedProcessingDeferralHandler,
  type IOSContinuedProcessingHandleState,
} from './iosContinuedProcessingPolicy';

const identity = {
  requestId: 'submission-a',
  meetingId: 'meeting-a',
  asrGeneration: 7,
};

function exactHandle(): IOSContinuedProcessingHandleState {
  return { ...identity, deferralRequested: false };
}

function operations(options: {
  fence?: () => Promise<boolean>;
  stage?: () => Promise<void>;
} = {}) {
  return {
    fenceGeneration: vi.fn(options.fence ?? (async () => true)),
    markStageDeferred: vi.fn(options.stage ?? (async () => undefined)),
    acknowledge: vi.fn(),
    onFenceError: vi.fn(),
    onStageError: vi.fn(),
  };
}

describe('iOS continued-processing deferral identity', () => {
  it('accepts the exact submission and ASR generation once', () => {
    const handle = {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 7,
      deferralRequested: false,
    };
    const event = { requestId: 'submission-a', meetingId: 'meeting-a', asrGeneration: 7 };
    expect(acceptIOSContinuedProcessingDeferral(handle, event)).toBe('accepted');
    expect(handle.deferralRequested).toBe(true);
    expect(acceptIOSContinuedProcessingDeferral(handle, event)).toBe('duplicate');
  });

  it('rejects a late callback from an older generation', () => {
    const handle = {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 8,
      deferralRequested: false,
    };
    expect(acceptIOSContinuedProcessingDeferral(handle, {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 7,
    })).toBe('identity_mismatch');
    expect(handle.deferralRequested).toBe(false);
  });

  it('allows native-only recovery to fence an unowned persisted generation', () => {
    expect(acceptIOSContinuedProcessingDeferral(undefined, {
      requestId: 'submission-after-relaunch',
      meetingId: 'meeting-a',
      asrGeneration: 9,
    })).toBe('unowned');
  });
});

describe('iOS continued-processing deferral orchestration', () => {
  it('marks deferred and acknowledges only after the exact generation was fenced', async () => {
    const ops = operations();
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(exactHandle(), identity)).resolves.toBe('fenced');
    expect(ops.fenceGeneration).toHaveBeenCalledWith(identity);
    expect(ops.markStageDeferred).toHaveBeenCalledWith(identity);
    expect(ops.acknowledge).toHaveBeenCalledWith(identity);
    expect(ops.fenceGeneration.mock.invocationCallOrder[0])
      .toBeLessThan(ops.markStageDeferred.mock.invocationCallOrder[0]);
    expect(ops.markStageDeferred.mock.invocationCallOrder[0])
      .toBeLessThan(ops.acknowledge.mock.invocationCallOrder[0]);
  });

  it('acknowledges a completed generation without regressing its ready stage', async () => {
    let stage: 'ready' | 'deferred' = 'ready';
    const ops = operations({
      fence: async () => false,
      stage: async () => { stage = 'deferred'; },
    });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(exactHandle(), identity)).resolves.toBe('stale_or_complete');
    expect(stage).toBe('ready');
    expect(ops.markStageDeferred).not.toHaveBeenCalled();
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('leaves stage and acknowledgement to the native fail-safe when SQLite fencing throws', async () => {
    const failure = new Error('private sqlite detail');
    const ops = operations({ fence: async () => { throw failure; } });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(exactHandle(), identity)).resolves.toBe('fence_failed');
    expect(ops.markStageDeferred).not.toHaveBeenCalled();
    expect(ops.acknowledge).not.toHaveBeenCalled();
    expect(ops.onFenceError).toHaveBeenCalledWith(failure);
  });

  it('coalesces concurrent duplicates behind one durable attempt and one acknowledgement', async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const ops = operations({ fence: () => pending });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);
    const handle = exactHandle();

    const first = handler(handle, identity);
    const duplicate = handler(handle, identity);
    expect(first).toBe(duplicate);
    await Promise.resolve();
    expect(ops.fenceGeneration).toHaveBeenCalledTimes(1);
    expect(ops.acknowledge).not.toHaveBeenCalled();

    release(true);
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['fenced', 'fenced']);
    expect(ops.markStageDeferred).toHaveBeenCalledTimes(1);
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('allows a later duplicate to retry after a failed fence without acknowledging the failure', async () => {
    const ops = operations({
      fence: vi.fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(false),
    });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);
    const handle = exactHandle();

    await expect(handler(handle, identity)).resolves.toBe('fence_failed');
    expect(ops.acknowledge).not.toHaveBeenCalled();
    await expect(handler(handle, identity)).resolves.toBe('stale_or_complete');
    expect(ops.fenceGeneration).toHaveBeenCalledTimes(2);
    expect(ops.markStageDeferred).not.toHaveBeenCalled();
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('fences an unowned persisted generation through the same CAS path', async () => {
    const ops = operations();
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(undefined, identity)).resolves.toBe('fenced');
    expect(ops.markStageDeferred).toHaveBeenCalledTimes(1);
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('acknowledges an unowned stale generation without changing the stage', async () => {
    const ops = operations({ fence: async () => false });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(undefined, identity)).resolves.toBe('stale_or_complete');
    expect(ops.markStageDeferred).not.toHaveBeenCalled();
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched owned identity without any durable or native side effect', async () => {
    const ops = operations();
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(exactHandle(), { ...identity, asrGeneration: 8 }))
      .resolves.toBe('identity_mismatch');
    expect(ops.fenceGeneration).not.toHaveBeenCalled();
    expect(ops.markStageDeferred).not.toHaveBeenCalled();
    expect(ops.acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges after a durable fence even if only stage presentation fails', async () => {
    const stageFailure = new Error('stage unavailable');
    const ops = operations({ stage: async () => { throw stageFailure; } });
    const handler = createIOSContinuedProcessingDeferralHandler(ops);

    await expect(handler(exactHandle(), identity)).resolves.toBe('fenced');
    expect(ops.onStageError).toHaveBeenCalledWith(stageFailure);
    expect(ops.acknowledge).toHaveBeenCalledTimes(1);
  });
});
