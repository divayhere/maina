export type PipelineWakeSnapshot = {
  generation: number;
  enqueueRequired: boolean;
  connectivityEpoch: number;
  activeAttemptToken: string | null;
  activeAttemptGeneration: number | null;
  activeAttemptLeaseUntil: number | null;
  lastRequestKey: string | null;
};

export type PipelineWakeRequestDecision = PipelineWakeSnapshot & {
  newlyRequested: boolean;
};

/**
 * Coalesce any number of signals into one pending generation. A request that
 * arrives during an active drain opens exactly one follow-up generation. A
 * retry of the same durable request key can reopen its existing generation
 * after a terminal Worker failure without manufacturing a newer generation.
 */
export function requestWakeGeneration(
  state: PipelineWakeSnapshot,
  input: { requestKey: string; connectivityRestored: boolean },
): PipelineWakeRequestDecision {
  if (state.enqueueRequired) {
    return {
      ...state,
      connectivityEpoch: state.connectivityEpoch
        + (input.connectivityRestored && input.requestKey !== state.lastRequestKey ? 1 : 0),
      lastRequestKey: input.requestKey,
      newlyRequested: false,
    };
  }
  // Reuse a generation only after a bounded Worker has ended. A duplicate
  // signal while that generation is actively draining must open a follow-up;
  // otherwise KEEP would suppress re-enqueue against the still-running work.
  const sameDurableRequest = !state.activeAttemptToken && state.lastRequestKey === input.requestKey;
  return {
    ...state,
    generation: sameDurableRequest ? state.generation : state.generation + 1,
    enqueueRequired: true,
    connectivityEpoch: state.connectivityEpoch
      + (input.connectivityRestored && !sameDurableRequest ? 1 : 0),
    lastRequestKey: input.requestKey,
    newlyRequested: true,
  };
}

export type PipelineWakeClaimDecision =
  | { status: 'claimed' | 'reclaimed'; generation: number }
  | { status: 'busy' | 'obsolete' | 'no_work'; generation: number };

/** A dead process loses its lease; exactly one later transaction may reclaim. */
export function decidePipelineWakeClaim(
  state: PipelineWakeSnapshot,
  expectedGeneration: number,
  now: number,
): PipelineWakeClaimDecision {
  if (expectedGeneration !== state.generation) {
    return { status: 'obsolete', generation: state.generation };
  }
  if (state.activeAttemptToken) {
    const leaseAlive = (state.activeAttemptLeaseUntil ?? 0) > now;
    if (leaseAlive) return { status: 'busy', generation: state.generation };
    return { status: 'reclaimed', generation: state.generation };
  }
  if (!state.enqueueRequired) return { status: 'no_work', generation: state.generation };
  return { status: 'claimed', generation: state.generation };
}

export function completeWakeClaim(
  state: PipelineWakeSnapshot,
  input: { tokenMatches: boolean; succeeded: boolean },
): PipelineWakeSnapshot {
  if (!input.tokenMatches) return state;
  return {
    ...state,
    enqueueRequired: input.succeeded ? state.enqueueRequired : true,
    activeAttemptToken: null,
    activeAttemptGeneration: null,
    activeAttemptLeaseUntil: null,
  };
}
