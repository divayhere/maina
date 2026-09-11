export type PipelineRecoveryResult = {
  nativeMeetings: number;
  pendingPackets: number;
  eligiblePackets: number;
  repairedReferences: number;
  meetingTagMutations: number;
};

export type PipelineRecoveryDependencies = {
  assertActive?(): Promise<void> | void;
  initDb(): Promise<void>;
  reconcilePendingNativeDiscards(): Promise<number>;
  establishNativeCaptureAutomaticWorkFence(): Promise<{ protectedMeetingIds: readonly string[] }>;
  repairStoredRecordingReferences(protectedMeetingIds?: readonly string[]): Promise<number>;
  getMeetingsWithDeletedAudio(): Promise<string[]>;
  markMeetingsAudioDeleted(ids: string[]): Promise<void>;
  reconcilePendingNativeMeetingWork(protectedMeetingIds?: readonly string[]): Promise<number>;
  enforceAudioRetentionPolicy(
    reason?: 'startup' | 'pipeline' | 'daily' | 'size_pressure' | 'diagnostics',
    protectedMeetingIds?: readonly string[],
  ): Promise<unknown>;
  reconcileAutoSummaryEligibility(): Promise<number>;
  reconcilePendingMeetingPackets(): Promise<number>;
  reconcilePendingMainaKnowledgeCloudSyncs(): Promise<unknown>;
  reconcilePendingMainaKnowledgeCloudCorrections(): Promise<unknown>;
  reconcilePendingMkcMeetingTagMutations(): Promise<{ attempted: number }>;
  flushDiagnostics(): Promise<unknown>;
};

/**
 * The product pipeline order is explicit and testable here: first make local
 * storage readable, then recover ASR, then notes, then immutable cloud work.
 */
export async function executePipelineRecovery(
  dependencies: PipelineRecoveryDependencies,
): Promise<PipelineRecoveryResult> {
  const checkpoint = async () => dependencies.assertActive?.();
  await checkpoint();
  await dependencies.initDb();
  await checkpoint();
  await dependencies.reconcilePendingNativeDiscards();
  await checkpoint();
  const nativeCaptureFence = await dependencies.establishNativeCaptureAutomaticWorkFence();
  const protectedMeetingIds = new Set(nativeCaptureFence.protectedMeetingIds);
  await checkpoint();
  const repairedReferences = await dependencies.repairStoredRecordingReferences([...protectedMeetingIds]);
  await checkpoint();
  const deletedAudioMeetingIds = (await dependencies.getMeetingsWithDeletedAudio().catch(() => []))
    .filter((meetingId) => !protectedMeetingIds.has(meetingId));
  await dependencies.markMeetingsAudioDeleted(deletedAudioMeetingIds);
  await checkpoint();
  const nativeMeetings = await dependencies.reconcilePendingNativeMeetingWork([...protectedMeetingIds]);
  await checkpoint();
  await dependencies.enforceAudioRetentionPolicy('pipeline', [...protectedMeetingIds]);
  await checkpoint();
  const eligiblePackets = await dependencies.reconcileAutoSummaryEligibility();
  await checkpoint();
  const pendingPackets = await dependencies.reconcilePendingMeetingPackets();
  await checkpoint();
  await dependencies.reconcilePendingMainaKnowledgeCloudSyncs();
  await checkpoint();
  await dependencies.reconcilePendingMainaKnowledgeCloudCorrections();
  await checkpoint();
  const meetingTagMutations = (await dependencies.reconcilePendingMkcMeetingTagMutations()).attempted;
  await checkpoint();
  await dependencies.flushDiagnostics().catch(() => {});
  return { nativeMeetings, pendingPackets, eligiblePackets, repairedReferences, meetingTagMutations };
}

/** Coalesces concurrent foreground/network/Worker signals into one drain. */
export function createCoalescedPipelineRunner<T>(
  execute: (assertActive?: () => Promise<void>) => Promise<T>,
): (assertActive?: () => Promise<void>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (assertActive) => {
    if (inFlight) return inFlight;
    const cycle = execute(assertActive).finally(() => {
      if (inFlight === cycle) inFlight = null;
    });
    inFlight = cycle;
    return cycle;
  };
}
