/* eslint-disable import/first -- Vitest hoisted mocks must exist before importing the subject. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  persistSignal: vi.fn(),
  getState: vi.fn(),
  generationAwaiting: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock('@/data/pipelineWake', () => ({
  persistPipelineWakeSignal: mocks.persistSignal,
  getPipelineWakeState: mocks.getState,
  generationAwaitingNativeSchedule: mocks.generationAwaiting,
  recordNativeScheduleOutcome: mocks.recordOutcome,
}));

import {
  armPipelineNetworkRecovery,
  registerNativePipelineWakeScheduler,
  repairDurablePipelineScheduling,
  requestDurablePipelineWake,
} from './pipelineWakeScheduler';

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.clearAllMocks();
});

describe('durable native scheduling boundary', () => {
  it('persists the signal before invoking the native scheduler', async () => {
    const order: string[] = [];
    mocks.persistSignal.mockImplementation(async () => {
      order.push('sqlite');
      return { requestedGeneration: 4 };
    });
    mocks.generationAwaiting.mockResolvedValue({ generation: 4, notBeforeAt: 100, scheduleRevision: 2 });
    mocks.getState.mockResolvedValue({
      requiresNetwork: true,
      lastEnqueuedWorkId: null,
      lastEnqueuedNotBeforeAt: null,
    });
    mocks.recordOutcome.mockResolvedValue({});
    unregister = registerNativePipelineWakeScheduler(async () => {
      order.push('native');
      return { outcome: 'enqueued', workId: 'work-4' };
    });
    await requestDurablePipelineWake({ reason: 'connectivity_restored', connected: true, requiresNetwork: true });
    expect(order).toEqual(['sqlite', 'native']);
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      generation: 4, outcome: 'enqueued', workId: 'work-4',
    }));
  });

  it('retains enqueue-required truth when the scheduler is unavailable', async () => {
    mocks.generationAwaiting.mockResolvedValue({ generation: 7, notBeforeAt: 200, scheduleRevision: 3 });
    mocks.getState.mockResolvedValue({
      requiresNetwork: true,
      lastEnqueuedWorkId: null,
      lastEnqueuedNotBeforeAt: null,
    });
    mocks.recordOutcome.mockResolvedValue({});
    await expect(repairDurablePipelineScheduling()).resolves.toEqual({ generation: 7, scheduled: false });
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      generation: 7, outcome: 'unavailable',
    }));
  });

  it('does not manufacture work during repair', async () => {
    mocks.generationAwaiting.mockResolvedValue(null);
    await expect(repairDurablePipelineScheduling()).resolves.toEqual({ generation: null, scheduled: false });
    expect(mocks.persistSignal).not.toHaveBeenCalled();
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });

  it('stops native enqueue repair after the bounded attempt budget', async () => {
    mocks.generationAwaiting.mockResolvedValue({ generation: 9, notBeforeAt: 300, scheduleRevision: 4 });
    mocks.getState.mockResolvedValue({
      requiresNetwork: true,
      nativeScheduleState: 'pending',
      nativeScheduleAttempts: 5,
      lastEnqueuedWorkId: null,
      lastEnqueuedNotBeforeAt: null,
    });
    mocks.recordOutcome.mockResolvedValue({});
    unregister = registerNativePipelineWakeScheduler(async () => ({ outcome: 'enqueued' }));
    await expect(repairDurablePipelineScheduling()).resolves.toEqual({ generation: 9, scheduled: false });
    expect(mocks.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      generation: 9,
      outcome: 'max_attempts',
    }));
  });

  it('can persist an active-drain signal without racing a native enqueue', async () => {
    mocks.persistSignal.mockResolvedValue({ requestedGeneration: 12 });
    await expect(requestDurablePipelineWake({
      reason: 'native_progress', scheduleNative: false,
    })).resolves.toEqual({ generation: 12, scheduled: false });
    expect(mocks.generationAwaiting).not.toHaveBeenCalled();
  });

  it('does not open a follow-up when a live durable drain already owns recovery', async () => {
    mocks.getState.mockResolvedValue({
      activeAttemptToken: 'owner', activeAttemptLeaseUntil: Date.now() + 60_000,
      activeAttemptGeneration: 5, requestedGeneration: 5,
    });
    await expect(armPipelineNetworkRecovery()).resolves.toEqual({ armed: true, generation: 5 });
    expect(mocks.persistSignal).not.toHaveBeenCalled();
  });
});
