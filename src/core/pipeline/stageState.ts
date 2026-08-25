export type PipelineStageState = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'deferred';

export type PersistedStageTiming = {
  state: PipelineStageState;
  attemptCount: number;
  startedAt?: number | null;
  completedUnits?: number | null;
  totalUnits?: number | null;
};

export type StageTransitionInput = {
  state: PipelineStageState;
  completedUnits?: number;
  totalUnits?: number;
  now: number;
};

export type DerivedStageTransition = {
  state: PipelineStageState;
  attemptCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  completedUnits: number;
  totalUnits: number;
};

/**
 * Stage-local retry and progress rules. This deliberately does not infer any
 * other stage: cloud, summary and transcript recovery must stay independent.
 */
export function deriveStageTransition(
  existing: PersistedStageTiming | null | undefined,
  input: StageTransitionInput,
): DerivedStageTransition {
  const beginsNewAttempt = input.state === 'running' && existing?.state !== 'running';
  const attemptCount = Math.max(0, existing?.attemptCount ?? 0) + (beginsNewAttempt ? 1 : 0);
  const startedAt = beginsNewAttempt ? input.now : existing?.startedAt ?? null;
  const completedUnits = Math.max(0, existing?.completedUnits ?? 0, input.completedUnits ?? 0);
  const totalUnits = Math.max(completedUnits, existing?.totalUnits ?? 0, input.totalUnits ?? 0);
  const terminal = input.state === 'ready' || input.state === 'failed';
  return {
    state: input.state,
    attemptCount,
    startedAt,
    finishedAt: terminal ? input.now : null,
    completedUnits,
    totalUnits,
  };
}
