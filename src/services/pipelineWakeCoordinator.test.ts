import { describe, expect, it, vi } from 'vitest';

import { createPipelineWakeCoordinator } from './pipelineWakeCoordinator';

describe('signal-to-durable pipeline wake coordination', () => {
  it('persists reconnect during an active drain and hands scheduling to one follow-up generation', async () => {
    let release!: () => void;
    const firstDrain = new Promise<void>((resolve) => { release = resolve; });
    const requestSignal = vi.fn(async () => ({ generation: 4 }));
    const persistConnectivity = vi.fn(async () => ({ reconnectGeneration: 5 }));
    const repairNativeScheduling = vi.fn(async () => undefined);
    const runGeneration = vi.fn(async (generation: number) => {
      if (generation === 4) await firstDrain;
      return { disposition: 'completed' as const, recovery: null };
    });
    const coordinator = createPipelineWakeCoordinator({
      requestSignal, persistConnectivity, repairNativeScheduling, runGeneration,
    });

    const foreground = coordinator.signal('foreground');
    await vi.waitFor(() => expect(runGeneration).toHaveBeenCalledWith(4));
    const reconnect = coordinator.connectivityChanged(true);
    await vi.waitFor(() => expect(persistConnectivity).toHaveBeenCalledWith(true));
    expect(runGeneration).toHaveBeenCalledTimes(1);
    expect(repairNativeScheduling).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([foreground, reconnect]);
    expect(runGeneration).toHaveBeenCalledTimes(1);
    // One repair occurs when reconnect persists N+1 and one when N releases
    // ownership. The durable generation, not another in-process drain, owns
    // the eventual native Worker.
    expect(repairNativeScheduling).toHaveBeenCalledTimes(2);
  });

  it('coalesces foreground and native progress only after both signals are persisted', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let generation = 8;
    const requestSignal = vi.fn(async () => ({ generation: generation++ }));
    const runGeneration = vi.fn(async () => {
      await gate;
      return { disposition: 'completed' as const, recovery: null };
    });
    const coordinator = createPipelineWakeCoordinator({
      requestSignal,
      persistConnectivity: vi.fn(async () => ({ reconnectGeneration: null })),
      repairNativeScheduling: vi.fn(async () => undefined),
      runGeneration,
    });

    const first = coordinator.signal('foreground');
    const second = coordinator.signal('native_progress');
    await vi.waitFor(() => expect(requestSignal).toHaveBeenCalledTimes(2));
    expect(runGeneration).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
  });
});
