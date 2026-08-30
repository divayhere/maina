export type NativeScheduleState = 'idle' | 'pending' | 'enqueued' | 'claimed' | 'max_attempts';

export type PipelineWakeSnapshot = {
  signalSequence: number;
  requestedGeneration: number;
  completedGeneration: number;
  enqueueRequired: boolean;
  connectivityEpoch: number;
  lastConnected: boolean | null;
  requiresNetwork: boolean;
  activeAttemptToken: string | null;
  activeAttemptGeneration: number | null;
  activeAttemptLeaseUntil: number | null;
  nativeScheduleState: NativeScheduleState;
  nativeScheduleAttempts: number;
};

export type PipelineWakeSignalDecision = PipelineWakeSnapshot & {
  signalPersisted: boolean;
  openedGeneration: boolean;
};

/**
 * Persist a genuine lifecycle/transport signal before any process-local drain
 * coalescing. Pending signals share one generation; a signal arriving while N
 * owns the drain opens exactly one N+1 generation.
 */
export function persistWakeSignal(
  state: PipelineWakeSnapshot,
  input: { connected?: boolean; requiresNetwork: boolean },
): PipelineWakeSignalDecision {
  const connectivityRestored = input.connected === true && state.lastConnected === false;
  const nextGeneration = state.activeAttemptGeneration != null
    ? Math.max(state.requestedGeneration, state.activeAttemptGeneration + 1)
    : state.requestedGeneration > state.completedGeneration
      ? state.requestedGeneration
      : state.completedGeneration + 1;
  const openedGeneration = nextGeneration !== state.requestedGeneration;
  return {
    ...state,
    signalSequence: state.signalSequence + 1,
    requestedGeneration: nextGeneration,
    enqueueRequired: true,
    connectivityEpoch: state.connectivityEpoch + (connectivityRestored ? 1 : 0),
    lastConnected: input.connected ?? state.lastConnected,
    requiresNetwork: state.requiresNetwork || input.requiresNetwork,
    nativeScheduleState: openedGeneration || state.nativeScheduleState === 'max_attempts'
      ? 'pending'
      : state.nativeScheduleState,
    nativeScheduleAttempts: openedGeneration || state.nativeScheduleState === 'max_attempts'
      ? 0
      : state.nativeScheduleAttempts,
    signalPersisted: true,
    openedGeneration,
  };
}

export type PipelineWakeClaimDecision =
  | { status: 'claimed' | 'reclaimed'; generation: number }
  | { status: 'busy' | 'obsolete' | 'no_work'; generation: number };

/** A dead process loses its lease; only its exact generation can be reclaimed. */
export function decidePipelineWakeClaim(
  state: PipelineWakeSnapshot,
  expectedGeneration: number,
  now: number,
): PipelineWakeClaimDecision {
  if (expectedGeneration <= state.completedGeneration || expectedGeneration > state.requestedGeneration) {
    return { status: 'obsolete', generation: state.requestedGeneration };
  }
  if (state.activeAttemptToken) {
    const leaseAlive = (state.activeAttemptLeaseUntil ?? 0) > now;
    if (leaseAlive || state.activeAttemptGeneration !== expectedGeneration) {
      return { status: 'busy', generation: state.activeAttemptGeneration ?? state.requestedGeneration };
    }
    return { status: 'reclaimed', generation: expectedGeneration };
  }
  const nextGeneration = state.completedGeneration + 1;
  if (expectedGeneration !== nextGeneration) {
    return expectedGeneration < nextGeneration
      ? { status: 'obsolete', generation: state.requestedGeneration }
      : { status: 'busy', generation: nextGeneration };
  }
  if (state.requestedGeneration < nextGeneration) {
    return { status: 'no_work', generation: state.requestedGeneration };
  }
  return { status: 'claimed', generation: expectedGeneration };
}

export function completeWakeClaim(
  state: PipelineWakeSnapshot,
  input: { tokenMatches: boolean; succeeded: boolean },
): PipelineWakeSnapshot {
  if (!input.tokenMatches || state.activeAttemptGeneration == null) return state;
  const completedGeneration = input.succeeded
    ? Math.max(state.completedGeneration, state.activeAttemptGeneration)
    : state.completedGeneration;
  const enqueueRequired = input.succeeded
    ? state.requestedGeneration > completedGeneration
    : true;
  return {
    ...state,
    completedGeneration,
    enqueueRequired,
    requiresNetwork: enqueueRequired ? state.requiresNetwork : false,
    activeAttemptToken: null,
    activeAttemptGeneration: null,
    activeAttemptLeaseUntil: null,
    nativeScheduleState: enqueueRequired ? 'pending' : 'idle',
    nativeScheduleAttempts: enqueueRequired ? 0 : state.nativeScheduleAttempts,
  };
}

/**
 * Pick the only generation that may be enqueued now. A live owner keeps N+1
 * durable but unscheduled; N completion hands it off without parallel drains.
 */
export function generationNeedingNativeSchedule(
  state: PipelineWakeSnapshot,
  now: number,
): number | null {
  if (!state.enqueueRequired) return null;
  if (state.activeAttemptToken) {
    if ((state.activeAttemptLeaseUntil ?? 0) > now) return null;
    return state.activeAttemptGeneration;
  }
  const next = state.completedGeneration + 1;
  return next <= state.requestedGeneration ? next : null;
}

export function markNativeScheduleOutcome(
  state: PipelineWakeSnapshot,
  input: {
    generation: number;
    outcome: 'enqueued' | 'unavailable' | 'failed' | 'max_attempts';
  },
): PipelineWakeSnapshot {
  if (input.generation < state.completedGeneration + 1 || input.generation > state.requestedGeneration) {
    return state;
  }
  return {
    ...state,
    nativeScheduleState: input.outcome === 'enqueued'
      ? 'enqueued'
      : input.outcome === 'max_attempts'
        ? 'max_attempts'
        : 'pending',
    nativeScheduleAttempts: state.nativeScheduleAttempts + 1,
    enqueueRequired: true,
  };
}
