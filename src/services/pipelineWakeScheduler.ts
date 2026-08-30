import {
  generationAwaitingNativeSchedule,
  getPipelineWakeState,
  persistPipelineWakeSignal,
  recordNativeScheduleOutcome,
  type PipelineWakeReason,
} from '@/data/pipelineWake';

export type NativeWakeScheduleResult = {
  outcome: 'enqueued' | 'unavailable' | 'failed';
  workId?: string | null;
  errorCode?: string | null;
};

export const MAX_NATIVE_SCHEDULE_ATTEMPTS = 5;

type NativeWakeScheduler = (
  input: {
    generation: number;
    requiresNetwork: boolean;
    notBeforeAt: number;
    scheduleRevision: number;
    previousWorkId: string | null;
    previousNotBeforeAt: number | null;
    previousScheduleRevision: number | null;
  },
) => Promise<NativeWakeScheduleResult>;

let nativeWakeScheduler: NativeWakeScheduler | null = null;

export function registerNativePipelineWakeScheduler(scheduler: NativeWakeScheduler): () => void {
  nativeWakeScheduler = scheduler;
  return () => {
    if (nativeWakeScheduler === scheduler) nativeWakeScheduler = null;
  };
}

export async function repairDurablePipelineScheduling(): Promise<{
  generation: number | null;
  scheduled: boolean;
}> {
  const target = await generationAwaitingNativeSchedule();
  if (target == null) return { generation: null, scheduled: false };
  const state = await getPipelineWakeState();
  if (state.nativeScheduleAttempts >= MAX_NATIVE_SCHEDULE_ATTEMPTS) {
    await recordNativeScheduleOutcome({
      generation: target.generation,
      scheduleRevision: target.scheduleRevision,
      notBeforeAt: target.notBeforeAt,
      outcome: 'max_attempts',
      errorCode: 'native_schedule_attempts_exhausted',
    });
    return { generation: target.generation, scheduled: false };
  }
  if (!nativeWakeScheduler) {
    await recordNativeScheduleOutcome({
      generation: target.generation,
      scheduleRevision: target.scheduleRevision,
      notBeforeAt: target.notBeforeAt,
      outcome: 'unavailable',
      errorCode: 'scheduler_unavailable',
    });
    return { generation: target.generation, scheduled: false };
  }
  let outcome: NativeWakeScheduleResult;
  try {
    const previousMatchesCurrent = state.lastEnqueuedGeneration === target.generation;
    outcome = await nativeWakeScheduler({
      generation: target.generation,
      requiresNetwork: state.requiresNetwork,
      notBeforeAt: target.notBeforeAt,
      scheduleRevision: target.scheduleRevision,
      previousWorkId: previousMatchesCurrent ? state.lastEnqueuedWorkId : null,
      previousNotBeforeAt: previousMatchesCurrent ? state.lastEnqueuedNotBeforeAt : null,
      previousScheduleRevision: previousMatchesCurrent ? state.lastEnqueuedScheduleRevision : null,
    });
  } catch (cause) {
    outcome = {
      outcome: 'failed',
      errorCode: cause instanceof Error ? cause.name : 'scheduler_failure',
    };
  }
  await recordNativeScheduleOutcome({
    generation: target.generation,
    scheduleRevision: target.scheduleRevision,
    notBeforeAt: target.notBeforeAt,
    outcome: outcome.outcome,
    workId: outcome.workId,
    errorCode: outcome.errorCode,
  });
  return { generation: target.generation, scheduled: outcome.outcome === 'enqueued' };
}

/** Persist first, then optionally observe the native enqueue outcome. */
export async function requestDurablePipelineWake(input: {
  reason: PipelineWakeReason;
  connected?: boolean;
  requiresNetwork?: boolean;
  scheduleNative?: boolean;
}): Promise<{ generation: number; scheduled: boolean }> {
  const state = await persistPipelineWakeSignal(input);
  if (input.scheduleNative === false) {
    return { generation: state.requestedGeneration, scheduled: false };
  }
  const schedule = await repairDurablePipelineScheduling();
  return {
    generation: state.requestedGeneration,
    scheduled: schedule.scheduled,
  };
}

/**
 * Observe a durable OS wake before a foreground cloud operation starts. An
 * existing live durable drain already owns recovery and does not need N+1.
 */
export async function armPipelineNetworkRecovery(): Promise<{
  armed: boolean;
  generation: number;
}> {
  const current = await getPipelineWakeState();
  if (current.activeAttemptToken && (current.activeAttemptLeaseUntil ?? 0) > Date.now()) {
    return { armed: true, generation: current.activeAttemptGeneration ?? current.requestedGeneration };
  }
  const result = await requestDurablePipelineWake({
    reason: 'transport_deferred',
    requiresNetwork: true,
    scheduleNative: true,
  });
  // The SQLite request is durable even when the native enqueue is temporarily
  // unavailable. Startup and the registered periodic task repair that gap.
  return { armed: result.scheduled, generation: result.generation };
}
