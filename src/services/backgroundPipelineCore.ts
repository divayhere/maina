export type PipelineRecoveryResult = {
  nativeMeetings: number;
  pendingPackets: number;
  eligiblePackets: number;
  repairedReferences: number;
};

export type PipelineRecoveryDependencies = {
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
  await dependencies.initDb();
  const repairedReferences = await dependencies.repairStoredRecordingReferences();
  const deletedAudioMeetingIds = await dependencies.getMeetingsWithDeletedAudio().catch(() => []);
  await dependencies.markMeetingsAudioDeleted(deletedAudioMeetingIds);
  const nativeMeetings = await dependencies.reconcilePendingNativeMeetingWork();
  await dependencies.enforceAudioRetentionPolicy();
  const eligiblePackets = await dependencies.reconcileAutoSummaryEligibility();
  const pendingPackets = await dependencies.reconcilePendingMeetingPackets();
  await dependencies.reconcilePendingMainaKnowledgeCloudSyncs();
  await dependencies.reconcilePendingMainaKnowledgeCloudCorrections();
  await dependencies.flushDiagnostics().catch(() => {});
  return { nativeMeetings, pendingPackets, eligiblePackets, repairedReferences };
}
