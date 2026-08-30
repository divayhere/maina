export type PipelineRecoveryResult = {
  nativeMeetings: number;
  pendingPackets: number;
  eligiblePackets: number;
  repairedReferences: number;
};

export type PipelineRecoveryDependencies = {
  assertActive?(): Promise<void> | void;
  initDb(): Promise<void>;
  repairStoredRecordingReferences(): Promise<number>;
  getMeetingsWithDeletedAudio(): Promise<string[]>;
  markMeetingsAudioDeleted(ids: string[]): Promise<void>;
  reconcilePendingNativeMeetingWork(): Promise<number>;
  enforceAudioRetentionPolicy(): Promise<unknown>;
  reconcileAutoSummaryEligibility(): Promise<number>;
  reconcilePendingMeetingPackets(): Promise<number>;
  reconcilePendingMainaKnowledgeCloudSyncs(): Promise<unknown>;
  reconcilePendingMainaKnowledgeCloudCorrections(): Promise<unknown>;
  flushDiagnostics(): Promise<unknown>;
};

export async function executePipelineRecovery(
  dependencies: PipelineRecoveryDependencies,
): Promise<PipelineRecoveryResult> {
  const checkpoint = async () => dependencies.assertActive?.();
  await checkpoint();
  await dependencies.initDb();
  await checkpoint();
  const repairedReferences = await dependencies.repairStoredRecordingReferences();
  await checkpoint();
  const deletedAudioMeetingIds = await dependencies.getMeetingsWithDeletedAudio().catch(() => []);
  await dependencies.markMeetingsAudioDeleted(deletedAudioMeetingIds);
  await checkpoint();
  const nativeMeetings = await dependencies.reconcilePendingNativeMeetingWork();
  await checkpoint();
  await dependencies.enforceAudioRetentionPolicy();
  await checkpoint();
  const eligiblePackets = await dependencies.reconcileAutoSummaryEligibility();
  await checkpoint();
  const pendingPackets = await dependencies.reconcilePendingMeetingPackets();
  await checkpoint();
  await dependencies.reconcilePendingMainaKnowledgeCloudSyncs();
  await checkpoint();
  await dependencies.reconcilePendingMainaKnowledgeCloudCorrections();
  await checkpoint();
  await dependencies.flushDiagnostics().catch(() => {});
  return { nativeMeetings, pendingPackets, eligiblePackets, repairedReferences };
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
