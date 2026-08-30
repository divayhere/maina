import type { PipelineWakeReason } from '@/data/pipelineWake';
import type { DurablePipelineWakeResult } from '@/services/backgroundPipeline';

type SignalReason = Extract<PipelineWakeReason, 'foreground' | 'native_progress'>;

export type PipelineWakeCoordinatorDependencies = {
  requestSignal(input: {
    reason: SignalReason;
    scheduleNative: false;
  }): Promise<{ generation: number }>;
  persistConnectivity(connected: boolean): Promise<{ reconnectGeneration: number | null }>;
  runGeneration(generation: number): Promise<DurablePipelineWakeResult>;
  repairNativeScheduling(): Promise<unknown>;
};

/**
 * Process-local serialization around the durable SQLite generation state.
 * Signals are always persisted first. A reconnect during generation N opens
 * durable N+1, but never starts a parallel outbox drain; N completion repairs
 * native scheduling so N+1 survives process death.
 */
export function createPipelineWakeCoordinator(
  dependencies: PipelineWakeCoordinatorDependencies,
) {
  let inFlight: Promise<void> | null = null;
  let durableMutationTail: Promise<void> = Promise.resolve();

  const mutateDurably = <T>(operation: () => Promise<T>): Promise<T> => {
    const mutation = durableMutationTail.then(operation, operation);
    durableMutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  };

  const run = (generation: number): Promise<void> => {
    if (inFlight) return inFlight;
    let work: Promise<void>;
    work = dependencies.runGeneration(generation)
      .then(() => undefined)
      .finally(async () => {
        if (inFlight === work) inFlight = null;
        // SQLite and the OS scheduler cannot commit atomically. This bounded
        // repair observes any N+1 or enqueue-required crash-window truth.
        await dependencies.repairNativeScheduling().catch(() => undefined);
      });
    inFlight = work;
    return work;
  };

  const beginSignal = async (reason: SignalReason): Promise<{
    generation: number;
    completion: Promise<void>;
  }> => {
    const { generation } = await mutateDurably(
      () => dependencies.requestSignal({ reason, scheduleNative: false }),
    );
    return { generation, completion: run(generation) };
  };

  return {
    beginSignal,
    async signal(reason: SignalReason): Promise<void> {
      const started = await beginSignal(reason);
      return started.completion;
    },
    async connectivityChanged(connected: boolean): Promise<void> {
      const { reconnectGeneration } = await mutateDurably(
        () => dependencies.persistConnectivity(connected),
      );
      if (reconnectGeneration == null) return;
      await dependencies.repairNativeScheduling();
      return run(reconnectGeneration);
    },
    isRunning(): boolean {
      return inFlight != null;
    },
  };
}
