export type PendingNativeDiscard =
  | { state: 'none' | 'blocked' }
  | {
    state: 'pending' | 'ready_for_ack';
    meetingId: string;
    discardId: string;
    directory: string;
    qualificationEvidenceDigest: string | null;
    generation: number;
  };

export type NativeDiscardProtocolDependencies = {
  getPending(): PendingNativeDiscard;
  prepare(meetingId: string, discardId: string): PendingNativeDiscard;
  commitLogicalDelete(input: {
    meetingId: string;
    discardId: string;
    captureDirectory: string;
    qualificationEvidenceDigest: string | null;
    captureGeneration: number;
    requestedAt: number;
  }): Promise<void>;
  listTombstones(): Promise<{
    meetingId: string;
    discardId: string;
    captureDirectory: string;
    qualificationEvidenceDigest: string | null;
    captureGeneration: number;
    requestedAt: number;
  }[]>;
  requestAbort(meetingId: string, discardId: string): Promise<void>;
  acknowledge(meetingId: string, discardId: string): Promise<void>;
  deleteDirectory(meetingId: string, directory: string): Promise<boolean>;
  completeTombstone(meetingId: string, discardId: string): Promise<void>;
  now(): number;
  delay(ms: number): Promise<void>;
};

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function exactOwner(
  state: PendingNativeDiscard,
  meetingId: string,
  discardId: string,
): state is Extract<PendingNativeDiscard, { state: 'pending' | 'ready_for_ack' }> {
  return (state.state === 'pending' || state.state === 'ready_for_ack')
    && state.meetingId === meetingId
    && state.discardId === discardId
    && state.directory.length > 0
    && state.directory.length <= 4096
    && (state.qualificationEvidenceDigest == null || SHA256.test(state.qualificationEvidenceDigest))
    && Number.isSafeInteger(state.generation)
    && state.generation >= 0;
}

function samePreparedOwner(
  state: PendingNativeDiscard,
  prepared: Extract<PendingNativeDiscard, { state: 'pending' | 'ready_for_ack' }>,
): state is Extract<PendingNativeDiscard, { state: 'pending' | 'ready_for_ack' }> {
  return exactOwner(state, prepared.meetingId, prepared.discardId)
    && state.directory === prepared.directory
    && state.qualificationEvidenceDigest === prepared.qualificationEvidenceDigest
    && state.generation === prepared.generation;
}

async function waitFor(
  dependencies: NativeDiscardProtocolDependencies,
  predicate: (state: PendingNativeDiscard) => boolean,
  timeoutMs = 20_000,
): Promise<PendingNativeDiscard> {
  const deadline = dependencies.now() + timeoutMs;
  let state = dependencies.getPending();
  while (!predicate(state) && dependencies.now() <= deadline) {
    if (state.state === 'blocked') throw new Error('native_discard_authority_blocked');
    await dependencies.delay(100);
    state = dependencies.getPending();
  }
  if (!predicate(state)) throw new Error('native_discard_acknowledgement_timeout');
  return state;
}

export async function executeNativeMeetingDiscard(input: {
  meetingId: string;
  discardId: string;
}, dependencies: NativeDiscardProtocolDependencies): Promise<void> {
  if (!ID.test(input.meetingId) || !ID.test(input.discardId)) {
    throw new Error('native_discard_identity_invalid');
  }
  // This synchronous commit is the accepted user-intent boundary. If the
  // process dies immediately afterwards, startup can reconstruct the SQLite
  // logical-delete tombstone from the retained native owner.
  const prepared = dependencies.prepare(input.meetingId, input.discardId);
  if (!exactOwner(prepared, input.meetingId, input.discardId)) {
    throw new Error('native_discard_prepare_failed');
  }
  // Native preparation has already latched reads off synchronously. Request
  // the idempotent abort before SQLite work so database contention can never
  // leave the microphone capturing after accepted Discard.
  await dependencies.requestAbort(input.meetingId, input.discardId);
  await dependencies.commitLogicalDelete({
    meetingId: prepared.meetingId,
    discardId: prepared.discardId,
    captureDirectory: prepared.directory,
    qualificationEvidenceDigest: prepared.qualificationEvidenceDigest,
    captureGeneration: prepared.generation,
    requestedAt: dependencies.now(),
  });
  await waitFor(
    dependencies,
    (state) => samePreparedOwner(state, prepared) && state.state === 'ready_for_ack',
  );
  await dependencies.acknowledge(input.meetingId, input.discardId);
  await waitFor(dependencies, (state) => state.state === 'none');
  await dependencies.completeTombstone(input.meetingId, input.discardId);
}

/** Runs before every foreground/headless generic recovery entry point. */
export async function reconcileNativeMeetingDiscards(
  dependencies: NativeDiscardProtocolDependencies,
): Promise<number> {
  const native = dependencies.getPending();
  if (native.state === 'blocked') throw new Error('native_discard_authority_blocked');
  let tombstones = await dependencies.listTombstones();
  if (native.state === 'pending' || native.state === 'ready_for_ack') {
    const retained = tombstones.find((item) => item.meetingId === native.meetingId);
    if (tombstones.length > 0 && !retained) throw new Error('native_discard_identity_conflict');
    if (retained) {
      if (retained.discardId !== native.discardId || retained.captureDirectory !== native.directory ||
        retained.qualificationEvidenceDigest !== native.qualificationEvidenceDigest ||
        retained.captureGeneration !== native.generation) {
        throw new Error('native_discard_identity_conflict');
      }
    } else {
      await dependencies.commitLogicalDelete({
        meetingId: native.meetingId,
        discardId: native.discardId,
        captureDirectory: native.directory,
        qualificationEvidenceDigest: native.qualificationEvidenceDigest,
        captureGeneration: native.generation,
        requestedAt: dependencies.now(),
      });
      tombstones = await dependencies.listTombstones();
    }
  }
  for (const tombstone of tombstones) {
    let current = dependencies.getPending();
    if (current.state === 'blocked') throw new Error('native_discard_authority_blocked');
    if (current.state === 'none') {
      if (!await dependencies.deleteDirectory(tombstone.meetingId, tombstone.captureDirectory)) {
        throw new Error('native_discard_directory_cleanup_failed');
      }
      await dependencies.completeTombstone(tombstone.meetingId, tombstone.discardId);
      continue;
    }
    if (!exactOwner(current, tombstone.meetingId, tombstone.discardId)) {
      throw new Error('native_discard_identity_conflict');
    }
    if (current.state === 'pending') {
      await dependencies.requestAbort(tombstone.meetingId, tombstone.discardId);
      current = await waitFor(
        dependencies,
        (state) => exactOwner(state, tombstone.meetingId, tombstone.discardId)
          && state.state === 'ready_for_ack',
      );
    }
    if (current.state !== 'ready_for_ack') throw new Error('native_discard_not_ready');
    await dependencies.acknowledge(tombstone.meetingId, tombstone.discardId);
    await waitFor(dependencies, (state) => state.state === 'none');
    await dependencies.completeTombstone(tombstone.meetingId, tombstone.discardId);
  }
  return tombstones.length;
}

/** One per JavaScript runtime; native transitions remain independently idempotent. */
export function createNativeDiscardCoordinator(dependencies: NativeDiscardProtocolDependencies) {
  let tail: Promise<void> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    execute: (input: { meetingId: string; discardId: string }) =>
      serial(() => executeNativeMeetingDiscard(input, dependencies)),
    reconcile: () => serial(() => reconcileNativeMeetingDiscards(dependencies)),
  };
}
