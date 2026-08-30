/* eslint-disable import/first -- Vitest hoisted mocks must exist before importing the subject. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestPipelineWake: vi.fn(),
  markPipelineWakeEnqueued: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/data/pipelineWake', () => ({
  requestPipelineWake: mocks.requestPipelineWake,
  markPipelineWakeEnqueued: mocks.markPipelineWakeEnqueued,
}));

vi.mock('@/services/logger', () => ({
  log: { warn: mocks.warn },
}));

import {
  registerNativePipelineWakeScheduler,
  requestDurablePipelineWake,
  scheduleExistingPipelineWake,
} from './pipelineWakeScheduler';

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.clearAllMocks();
});

describe('pipeline wake scheduling boundary', () => {
  it('leaves committed SQLite work pending when native enqueue fails', async () => {
    mocks.requestPipelineWake.mockResolvedValue({ generation: 4, enqueueRequired: true });
    unregister = registerNativePipelineWakeScheduler(vi.fn(async () => {
      throw new Error('scheduler unavailable');
    }));
    await expect(requestDurablePipelineWake({
      reason: 'connectivity_restored',
      requestKey: 'network:4',
      connectivityRestored: true,
    })).resolves.toEqual({ generation: 4, scheduled: false });
    expect(mocks.markPipelineWakeEnqueued).not.toHaveBeenCalled();
  });

  it('reconciles an already committed generation without creating new state', async () => {
    const scheduler = vi.fn(async () => true);
    unregister = registerNativePipelineWakeScheduler(scheduler);
    await expect(scheduleExistingPipelineWake(9)).resolves.toBe(true);
    expect(scheduler).toHaveBeenCalledWith(9);
    expect(mocks.requestPipelineWake).not.toHaveBeenCalled();
    expect(mocks.markPipelineWakeEnqueued).toHaveBeenCalledWith(9);
  });

  it('passes one committed generation through concurrent scheduling signals', async () => {
    mocks.requestPipelineWake.mockResolvedValue({ generation: 12, enqueueRequired: true });
    const scheduler = vi.fn(async () => true);
    unregister = registerNativePipelineWakeScheduler(scheduler);
    const [network, foreground] = await Promise.all([
      requestDurablePipelineWake({
        reason: 'connectivity_restored',
        requestKey: 'network:12',
        connectivityRestored: true,
      }),
      requestDurablePipelineWake({
        reason: 'foreground',
        requestKey: 'foreground:12',
      }),
    ]);
    expect(network.generation).toBe(12);
    expect(foreground.generation).toBe(12);
    expect(scheduler).toHaveBeenNthCalledWith(1, 12);
    expect(scheduler).toHaveBeenNthCalledWith(2, 12);
  });
});
