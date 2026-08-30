export type NativeScheduleState = 'idle' | 'pending' | 'enqueued' | 'claimed' | 'max_attempts';

export type PipelineWakeSnapshot = {
  signalSequence: number;
  requestedGeneration: number;
  completedGeneration: number;
  currentGeneration: number | null;
  currentRetryNotBeforeAt: number | null;
  pendingGeneration: number | null;
  pendingNotBeforeAt: number | null;
  enqueueRequired: boolean;
  connectivityEpoch: number;
  lastConnected: boolean | null;
  requiresNetwork: boolean;
  activeAttemptToken: string | null;
  activeAttemptGeneration: number | null;
  activeAttemptLeaseUntil: number | null;
  nativeScheduleState: NativeScheduleState;
  nativeScheduleAttempts: number;
  nativeScheduleRevision: number;
};

export type PipelineWakeSignalDecision = PipelineWakeSnapshot & {
  signalPersisted: boolean;
  openedGeneration: boolean;
};

const minDue = (left: number | null, right: number) => left == null ? right : Math.min(left, right);

/**
 * Persist one signal without overwriting current generation N with successor
 * N+1. Expiration makes N reclaimable while retaining the exact N+1 due tuple.
 */
export function persistDeferredWakeSignal(
  state: PipelineWakeSnapshot,
  input: { connected?: boolean; requiresNetwork: boolean; notBeforeAt: number },
  now: number,
): PipelineWakeSignalDecision {
  const connectivityRestored = input.connected === true && state.lastConnected === false;
  const previousHighest = Math.max(
    state.requestedGeneration,
    state.currentGeneration ?? 0,
    state.pendingGeneration ?? 0,
  );
  let currentGeneration = state.currentGeneration;
  let currentRetryNotBeforeAt = state.currentRetryNotBeforeAt;
  let pendingGeneration = state.pendingGeneration;
  let pendingNotBeforeAt = state.pendingNotBeforeAt;
  let nativeScheduleRevision = state.nativeScheduleRevision;
  let nativeScheduleState = state.nativeScheduleState;
  let nativeScheduleAttempts = state.nativeScheduleAttempts;

  const liveCurrentOwner = state.activeAttemptToken != null
    && state.activeAttemptGeneration === currentGeneration
    && (state.activeAttemptLeaseUntil ?? 0) > now;
  const expiredCurrentOwner = state.activeAttemptToken != null
    && state.activeAttemptGeneration === currentGeneration
    && (state.activeAttemptLeaseUntil ?? 0) <= now;
  let currentScheduleChanged = false;

  if (currentGeneration == null) {
    currentGeneration = state.completedGeneration + 1;
    currentRetryNotBeforeAt = input.notBeforeAt;
    currentScheduleChanged = true;
  } else if (liveCurrentOwner || expiredCurrentOwner) {
    if (expiredCurrentOwner) {
      // N's dead lease must be reclaimable now. The arriving signal still
      // belongs to N+1; its possibly later due must never postpone recovery N.
      const reclaimDue = minDue(currentRetryNotBeforeAt, now);
      currentScheduleChanged = reclaimDue !== currentRetryNotBeforeAt;
      currentRetryNotBeforeAt = reclaimDue;
    }
    const successor = currentGeneration + 1;
    if (pendingGeneration == null) {
      pendingGeneration = successor;
      pendingNotBeforeAt = input.notBeforeAt;
    } else if (pendingGeneration === successor) {
      pendingNotBeforeAt = minDue(pendingNotBeforeAt, input.notBeforeAt);
    }
  } else {
    const nextDue = minDue(currentRetryNotBeforeAt, input.notBeforeAt);
    currentScheduleChanged = nextDue !== currentRetryNotBeforeAt;
    currentRetryNotBeforeAt = nextDue;
  }

  if (currentScheduleChanged || state.nativeScheduleState === 'max_attempts') {
    nativeScheduleRevision += 1;
    nativeScheduleState = 'pending';
    nativeScheduleAttempts = 0;
  }

  const requestedGeneration = Math.max(
    state.completedGeneration,
    currentGeneration ?? 0,
    pendingGeneration ?? 0,
  );
  return {
    ...state,
    signalSequence: state.signalSequence + 1,
    requestedGeneration,
    currentGeneration,
    currentRetryNotBeforeAt,
    pendingGeneration,
    pendingNotBeforeAt,
    enqueueRequired: currentGeneration != null,
    connectivityEpoch: state.connectivityEpoch + (connectivityRestored ? 1 : 0),
    lastConnected: input.connected ?? state.lastConnected,
    requiresNetwork: state.requiresNetwork || input.requiresNetwork,
    nativeScheduleState,
    nativeScheduleAttempts,
    nativeScheduleRevision,
    signalPersisted: true,
    openedGeneration: requestedGeneration > previousHighest,
  };
}

export function persistWakeSignal(
  state: PipelineWakeSnapshot,
  input: { connected?: boolean; requiresNetwork: boolean },
  now = Date.now(),
): PipelineWakeSignalDecision {
  return persistDeferredWakeSignal(state, { ...input, notBeforeAt: now }, now);
}

export type PipelineWakeClaimDecision =
  | { status: 'claimed' | 'reclaimed'; generation: number }
  | { status: 'busy' | 'obsolete' | 'no_work' | 'not_due'; generation: number; notBeforeAt?: number };

/** A dead process loses only N's lease; its successor remains untouched. */
export function decidePipelineWakeClaim(
  state: PipelineWakeSnapshot,
  expectedGeneration: number,
  now: number,
): PipelineWakeClaimDecision {
  const current = state.currentGeneration;
  if (current == null) return { status: 'no_work', generation: state.completedGeneration };
  if (expectedGeneration < current || expectedGeneration <= state.completedGeneration) {
    return { status: 'obsolete', generation: current };
  }
  if (expectedGeneration > current) return { status: 'busy', generation: current };
  if (state.activeAttemptToken) {
    const leaseAlive = (state.activeAttemptLeaseUntil ?? 0) > now;
    if (leaseAlive || state.activeAttemptGeneration !== current) {
      return { status: 'busy', generation: state.activeAttemptGeneration ?? current };
    }
    return { status: 'reclaimed', generation: current };
  }
  const dueAt = state.currentRetryNotBeforeAt ?? now;
  if (dueAt > now) return { status: 'not_due', generation: current, notBeforeAt: dueAt };
  return { status: 'claimed', generation: current };
}

export function completeWakeClaim(
  state: PipelineWakeSnapshot,
  input: {
    tokenMatches: boolean;
    succeeded: boolean;
    now: number;
    failureRetryAt?: number;
    canonicalNextDueAt?: number | null;
  },
): PipelineWakeSnapshot {
  const active = state.activeAttemptGeneration;
  if (!input.tokenMatches || active == null || active !== state.currentGeneration) return state;

  if (!input.succeeded) {
    return {
      ...state,
      currentRetryNotBeforeAt: input.failureRetryAt ?? input.now,
      enqueueRequired: true,
      activeAttemptToken: null,
      activeAttemptGeneration: null,
      activeAttemptLeaseUntil: null,
      nativeScheduleState: 'pending',
      nativeScheduleAttempts: 0,
      nativeScheduleRevision: state.nativeScheduleRevision + 1,
    };
  }

  const completedGeneration = Math.max(state.completedGeneration, active);
  let currentGeneration = state.pendingGeneration;
  let currentRetryNotBeforeAt = state.pendingNotBeforeAt;
  if (input.canonicalNextDueAt != null) {
    if (currentGeneration == null) {
      currentGeneration = completedGeneration + 1;
      currentRetryNotBeforeAt = input.canonicalNextDueAt;
    } else {
      currentRetryNotBeforeAt = minDue(currentRetryNotBeforeAt, input.canonicalNextDueAt);
    }
  }
  const hasNext = currentGeneration != null;
  return {
    ...state,
    requestedGeneration: hasNext ? currentGeneration! : completedGeneration,
    completedGeneration,
    currentGeneration,
    currentRetryNotBeforeAt,
    pendingGeneration: null,
    pendingNotBeforeAt: null,
    enqueueRequired: hasNext,
    requiresNetwork: hasNext ? state.requiresNetwork : false,
    activeAttemptToken: null,
    activeAttemptGeneration: null,
    activeAttemptLeaseUntil: null,
    nativeScheduleState: hasNext ? 'pending' : 'idle',
    nativeScheduleAttempts: 0,
    nativeScheduleRevision: state.nativeScheduleRevision + (hasNext ? 1 : 0),
  };
}

export type PipelineWakeNativeTarget = {
  generation: number;
  notBeforeAt: number;
  scheduleRevision: number;
};

/** Native scheduling always prioritizes current N; N+1 is hidden until promotion. */
export function generationNeedingNativeSchedule(
  state: PipelineWakeSnapshot,
  now: number,
): PipelineWakeNativeTarget | null {
  const current = state.currentGeneration;
  if (!state.enqueueRequired || current == null) return null;
  if (state.activeAttemptToken && (state.activeAttemptLeaseUntil ?? 0) > now) return null;
  return {
    generation: current,
    notBeforeAt: state.currentRetryNotBeforeAt ?? now,
    scheduleRevision: state.nativeScheduleRevision,
  };
}

export function markNativeScheduleOutcome(
  state: PipelineWakeSnapshot,
  input: {
    generation: number;
    scheduleRevision: number;
    outcome: 'enqueued' | 'unavailable' | 'failed' | 'max_attempts';
  },
): PipelineWakeSnapshot {
  if (input.generation !== state.currentGeneration || input.scheduleRevision !== state.nativeScheduleRevision) {
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
