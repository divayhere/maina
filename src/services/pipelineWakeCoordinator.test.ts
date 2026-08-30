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

  it('persists startup foreground and every false-to-true connectivity edge in FIFO order', async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let releaseFirstMutation!: () => void;
    const firstMutation = new Promise<void>((resolve) => { releaseFirstMutation = resolve; });
    const mutationOrder: string[] = [];
    const packetJobs = new Set<string>();
    const sourceKeys = new Set<string>();
    let firstSignal = true;
    const requestSignal = vi.fn(async ({ reason }: { reason: string }) => {
      mutationOrder.push(`signal:${reason}:start`);
      if (firstSignal) {
        firstSignal = false;
        await firstMutation;
      }
      mutationOrder.push(`signal:${reason}:commit`);
      return { generation: reason === 'foreground' ? 4 : 6 };
    });
    const persistConnectivity = vi.fn(async (connected: boolean) => {
      mutationOrder.push(`connectivity:${connected}`);
      return { reconnectGeneration: connected ? 5 : null };
    });
    const repairNativeScheduling = vi.fn(async () => undefined);
    const runGeneration = vi.fn(async (generation: number) => {
      packetJobs.add('stable-job');
      sourceKeys.add('meeting:maina:stable-source');
      if (generation === 4) await drain;
      return { disposition: 'completed' as const, recovery: null };
    });
    const coordinator = createPipelineWakeCoordinator({
      requestSignal, persistConnectivity, repairNativeScheduling, runGeneration,
    });

    const initial = coordinator.beginSignal('foreground');
    const offline = coordinator.connectivityChanged(false);
    const online = coordinator.connectivityChanged(true);
    const nativeProgress = coordinator.signal('native_progress');

    await Promise.resolve();
    expect(mutationOrder).toEqual(['signal:foreground:start']);
    releaseFirstMutation();
    const started = await initial;
    await vi.waitFor(() => expect(runGeneration).toHaveBeenCalledWith(4));
    await vi.waitFor(() => expect(persistConnectivity).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(repairNativeScheduling).toHaveBeenCalledTimes(1));

    expect(mutationOrder).toEqual([
      'signal:foreground:start',
      'signal:foreground:commit',
      'connectivity:false',
      'connectivity:true',
      'signal:native_progress:start',
      'signal:native_progress:commit',
    ]);
    expect(repairNativeScheduling).toHaveBeenCalledTimes(1);
    expect(runGeneration).toHaveBeenCalledTimes(1);
    expect(packetJobs).toEqual(new Set(['stable-job']));
    expect(sourceKeys).toEqual(new Set(['meeting:maina:stable-source']));

    releaseDrain();
    await Promise.all([started.completion, offline, online, nativeProgress]);
  });

  it('does not hold the durable mutation lane while generation N is draining', async () => {
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const persistConnectivity = vi.fn(async () => ({ reconnectGeneration: 12 }));
    const repairNativeScheduling = vi.fn(async () => undefined);
    const runGeneration = vi.fn(async (generation: number) => {
      if (generation === 11) await drain;
      return { disposition: 'completed' as const, recovery: null };
    });
    const coordinator = createPipelineWakeCoordinator({
      requestSignal: vi.fn(async () => ({ generation: 11 })),
      persistConnectivity,
      repairNativeScheduling,
      runGeneration,
    });

    const foreground = coordinator.signal('foreground');
    await vi.waitFor(() => expect(runGeneration).toHaveBeenCalledWith(11));
    const reconnect = coordinator.connectivityChanged(true);

    await vi.waitFor(() => expect(persistConnectivity).toHaveBeenCalledWith(true));
    expect(repairNativeScheduling).toHaveBeenCalledTimes(1);
    expect(runGeneration).toHaveBeenCalledTimes(1);

    releaseDrain();
    await Promise.all([foreground, reconnect]);
    expect(repairNativeScheduling).toHaveBeenCalledTimes(2);
  });
});
