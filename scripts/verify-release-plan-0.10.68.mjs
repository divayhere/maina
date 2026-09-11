import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');
const gitObjectType = (spec) => {
  const result = spawnSync('git', ['-C', root, 'cat-file', '-t', spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : null;
};
const assertPinnedBlob = (commit, relative) => {
  assert.equal(
    gitObjectType(`${commit}:${relative}`),
    'blob',
    `${relative} must resolve to a blob at ${commit}`,
  );
};

const historicalPlan = json('release/m3-m4-0.10.67-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.67.schema.json');
const plan = json('release/m3-m4-0.10.68-candidate-plan.json');
const schema = json('release/provenance-0.10.68.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');
const releaseVerifier = source('scripts/verify-release.sh');

assert.equal(sha256('release/m3-m4-0.10.67-candidate-plan.json'), '0e7be4cdb085286b3a89a71bc09d43934d7184ac557a8a8c7dbf3c79c4c26009');
assert.equal(sha256('release/provenance-0.10.67.schema.json'), '728b37d2a678a513bf2cb7b965cc1c22e719212916da2ea650e90feee777f43d');
assert.deepEqual(historicalPlan.release, { version: '0.10.67', androidVersionCode: 93, iosBuildNumber: '49' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.67');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.68');
assert.deepEqual(plan.release, { version: '0.10.68', androidVersionCode: 94, iosBuildNumber: '50' });
assert.equal(plan.sources.android.productCommit, 'b294ed5fd5256f44efcb8ec7e4a7e4b00b4fab86');
assert.equal(plan.sources.ios.productCommit, '14725e58d61c30355be27552da1d35a8e18659cf');
assert.equal(plan.sources.coordinationCommit, 'b63b421b5d36b8fc3f54c347927ddfe496125e4e');
assert.equal(
  execFileSync('git', ['-C', path.join(root, 'coordination'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  plan.sources.coordinationCommit,
);
assert.equal(plan.sources.backendSourceCommit, historicalPlan.sources.backendSourceCommit);
assert.equal(plan.sources.backendProductionDeployment, historicalPlan.sources.backendProductionDeployment);
assert.equal(plan.identity.androidPackage, 'com.divay.maina');
assert.equal(plan.identity.iosBundleIdentifier, 'com.divay.maina.staging');
assert.equal(plan.identity.iosTeamId, '9X4X3R4KCN');
assert.deepEqual(plan.artifactPolicy, historicalPlan.artifactPolicy);
const expectedToolchains = structuredClone(historicalPlan.toolchains);
expectedToolchains.node = '24.19.0';
expectedToolchains.nodeExecutablePath = '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
expectedToolchains.nodeExecutableSha256 = '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1';
expectedToolchains.npm = '11.19.0';
expectedToolchains.npmCliPath = '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
expectedToolchains.npmCliSha256 = '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7';
expectedToolchains.npmManifestSha256 = '09dfcf187178ce1ab3ea6194c80d3ae082ad2a86dc1269ac963f94429e718122';
expectedToolchains.expo = '57.0.18';
expectedToolchains.expoCli = '57.0.20';
expectedToolchains.expoCliSha256 = '644f576d9a0d2347142ae3dc0cad7f13a79171d012cf1a361e2af0880cbb85bd';
expectedToolchains.expoManifestSha256 = '6bd6bce45f07477244f0cdb4bdc184a7f4cd4f5c68932849895efe190fe2591c';
expectedToolchains.expoCliManifestSha256 = '7f2ac24b75401eab942e31d446957ccd96f29351d77322f0a78fbda87c60ee67';
assert.deepEqual(plan.toolchains, expectedToolchains);
assert.deepEqual(plan.buildPolicy, historicalPlan.buildPolicy);

assert.equal(schema.properties.releaseId.const, plan.releaseId);
assert.deepEqual(schema.properties.release.properties, {
  version: { const: plan.release.version },
  androidVersionCode: { const: plan.release.androidVersionCode },
  iosBuildNumber: { const: plan.release.iosBuildNumber },
});
const normalizedSchema = structuredClone(schema);
normalizedSchema.$id = historicalSchema.$id;
normalizedSchema.title = historicalSchema.title;
normalizedSchema.properties.releaseId.const = historicalSchema.properties.releaseId.const;
normalizedSchema.properties.release.properties.version.const = historicalSchema.properties.release.properties.version.const;
normalizedSchema.properties.release.properties.androidVersionCode.const = historicalSchema.properties.release.properties.androidVersionCode.const;
normalizedSchema.properties.release.properties.iosBuildNumber.const = historicalSchema.properties.release.properties.iosBuildNumber.const;
assert.deepEqual(normalizedSchema, historicalSchema);

assert.equal(app.version, plan.release.version);
assert.equal(app.android.package, plan.identity.androidPackage);
assert.equal(app.android.versionCode, plan.release.androidVersionCode);
assert.equal(manifest.version, plan.release.version);
assert.equal(lock.version, plan.release.version);
assert.equal(lock.packages[''].version, plan.release.version);
assert.match(manifest.scripts['verify:android-lifecycle-qualification'], new RegExp(plan.toolchains.nodeExecutablePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.equal(manifest.scripts['verify:android-qualification-diagnostics'], `${plan.toolchains.nodeExecutablePath} scripts/verify-android-qualification-diagnostics.mjs`);
assert.equal(manifest.scripts['qualify:android-lifecycle'], `${plan.toolchains.nodeExecutablePath} scripts/run-android-lifecycle-qualification.mjs`);
assert.equal(manifest.scripts['qualify:android-lifecycle:verify'], `${plan.toolchains.nodeExecutablePath} scripts/verify-android-lifecycle-evidence.mjs`);
assert.match(releaseVerifier, /npm run verify:android-lifecycle-qualification/);
assert.match(source('android/app/build.gradle'), /versionCode 94/);
assert.match(source('android/app/build.gradle'), /versionName "0\.10\.68"/);

assert.deepEqual(plan.featureFlagDefaults, {
  mobileMemorySurfaceV1: false,
  mobileCloudMeetingsV1: false,
  mobileFrozenHandoffV1: false,
  mobileMemoryPulseV1: false,
  mobileSavedRecallsV1: false,
  mobileVerifiedLinksV1: false,
  mobileMeetingTagsV1: false,
  pulseBackgroundPolling: false,
  smartRecallAutomaticExecution: false,
  pulseRefreshMode: 'manual-only',
  smartRecallExecutionMode: 'manual-only',
});
assert.deepEqual(plan.provenancePolicy, {
  schema: 'release/provenance-0.10.68.schema.json',
  initialApproval: { status: 'candidate', approvedBy: null, approvedAt: null },
  requiresBothExactArtifactsBeforeAuthorization: true,
  requiresFreshDualArtifactAndBuildLogRevalidation: true,
});
assert.equal(plan.buildPolicy.requireExactGeneratedNativeMetadata, true);

assert.deepEqual(plan.postInstallQualification.androidCommandAndPermissionSafety, {
  sourceContracts: [
    'app.json',
    'modules/maina-recorder/android/src/main/AndroidManifest.xml',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaHardwareTrigger.kt',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt',
    'scripts/maina-button-bridge.sh',
    'scripts/android-soak-monitor.sh',
  ],
  staticVerifier: 'scripts/verify-android-command-surface.mjs',
  emulatorVerifier: 'scripts/verify-android-command-surface-emulator.mjs',
  emulatorApiLevels: [32, 36],
  requiredArtifactTruths: {
    legacyCommandReceiverNonExported: true,
    shellReceiverRequiresAndroidPermissionDump: true,
    externalStoragePermissionsAbsent: true,
    overlayPermissionAbsentFromRelease: true,
    candidateApkHashBoundBeforeDeviceAccess: true,
    hostileAppCannotChangeRecorderState: true,
    shellCommandRequiresExactStateAndFreshNonce: true,
    hostileAndShellBroadcastsReachIdleBeforeObservation: true,
    postAttackStabilityHorizonMilliseconds: 30000,
  },
  freshCandidateEmulatorReplayRequired: true,
  physicalDeviceCommandsRequired: false,
});

const androidProductCommit = plan.sources.android.productCommit;
assert.equal(gitObjectType(`${androidProductCommit}^{commit}`), 'commit');
const androidS2SourceContracts = [...new Set([
  plan.postInstallQualification.androidCallInterruptionSafety.sourceContract,
  ...plan.postInstallQualification.androidNativeTerminalSafety.sourceContracts,
  ...plan.postInstallQualification.androidCommandAndPermissionSafety.sourceContracts,
])];
for (const relative of androidS2SourceContracts) assertPinnedBlob(androidProductCommit, relative);
assert.throws(
  () => assertPinnedBlob(
    androidProductCommit,
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaShellCommandReceiver.kt',
  ),
  /must resolve to a blob/,
);
assert.throws(
  () => assertPinnedBlob(androidProductCommit, 'modules/maina-recorder/android/src/main/java'),
  /must resolve to a blob/,
);
const pinnedShellReceiverSource = execFileSync(
  'git',
  ['-C', root, 'show', `${androidProductCommit}:modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaHardwareTrigger.kt`],
  { encoding: 'utf8' },
);
assert.match(
  pinnedShellReceiverSource,
  /\bclass\s+MainaShellCommandReceiver\s*:\s*BroadcastReceiver\s*\(\s*\)/,
);

const tags = plan.sourceQualification.mobileMeetingTags;
assert.deepEqual(tags, {
  defaultEnabled: false,
  backendMigrationQualified: false,
  backendDeploymentQualified: false,
  uiDefaultEnabled: false,
  networkMutationsEnabled: false,
  backendSourceCommit: '0faf14d6b089d2e386cca6649c2f1dc5792bc7ac',
  coordinationAcceptanceCommit: 'a8184f6f1baef08bb0eae2865c8467c035a6c0db',
  acceptanceReceiptSha256: 'e427216f3d06c52c5d343c15d234aab4d35b14e7ed48eb0c6c1e49f08aa3a7c4',
  contractSha256: '7a526d5f5e79ec50d0fcdb30a20a280aa23216283b8f96eff44ffca71b000310',
  exampleSha256: '3ebbfdf92457f1253397ac27e266a7c44094956edd0ac92e940400f60419d2e2',
  openapiSha256: '584b1669d71135c4651e87f669c460187b2c7595033d5733ad3843623b921d10',
  validatorSha256: 'cee0f011307462fcca12364b0917fd43962f22d04a3c3b70281ada12425764c0',
  serviceSha256: '10c856a0ef851022d31a056de43c0ce845437b9ae89fda472ad1b29ee9e4ca15',
  migrationSha256: '934ab6decfa78524beceb5573a3629794d62fb79bf68b62dc9e5a43918e539e3',
  verifier: 'npm run verify:mkc-meeting-tags',
  requiredSourceTruths: {
    oneStableMeetingIdentity: true,
    originalTranscriptAudioChecksumImmutable: true,
    ownerSessionPinnedAcrossMutationAndConflictRefresh: true,
    sessionReplacementSerializedAgainstConditional401Clear: true,
    sameSubjectOutboxSerialization: true,
    preservedDatabaseUpgradeIsAppendOnly: true,
    conflictRefreshAndReconciliationAtomic: true,
    pipelineWakeIncludesQueuedRetryableAndRunningTagWork: true,
    datesAndTagsRemainEligibilityConstraintsBeforeRanking: true,
  },
});
assert.match(source('src/services/mkc-memory-flags.ts'), /mobileMeetingTagsV1/);
assert.match(source('src/services/mkc-meeting-tags-core.ts'), /backendMigrationQualified: false/);
assert.match(source('src/services/mkc-meeting-tags-core.ts'), /networkMutationsEnabled: false/);
assert.match(source('src/services/mkc-meeting-tags-outbox.ts'), /executionContext/);
assert.match(source('src/services/mainaCloudSession.ts'), /withSessionMutation/);
assert.match(source('src/services/mainaCloudSession.test.ts'), /serializes a replacement save behind an in-flight matching 401 clear/);
assert.match(source('src/data/db.ts'), /migrateMeetingTagOutboxV19/);
assert.match(source('src/data/pipelineWake.ts'), /meeting_tag_outbox/);

const drawer = plan.postInstallQualification.drawerAccessibility;
assert.equal(drawer.sourceContract, 'src/design/shell.accessibility.test.mjs');
assert.equal(drawer.openMenuLabel, 'Open menu');
assert.equal(drawer.closeMenuLabel, 'Close menu');
assert.match(drawer.requiredSemantics, /Settings must be both named and clickable/);

assert.deepEqual(plan.postInstallQualification.androidCallInterruptionSafety, {
  sourceContract: 'modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt',
  nativeVerifier: 'scripts/verify-native-recorder.mjs',
  requiredInstalledTruths: {
    systemInterruptionRetainsExactRecorderAndDrainsWithoutPersistence: true,
    communicationActiveOrExactClientSilencedDiscardsEveryBuffer: true,
    systemDrainFinalizesActiveChunkBehindCommitBarrier: true,
    resumeRequiresMatchingGenerationNormalModeExactUnsilencedRecordingOwner: true,
    resumeTapPreservesSystemRecoveryOwnership: true,
    manualResumeCoalescesBehindPauseCheckpoint: true,
    visibleResumeDuringPauseBridgeQueuesExactlyOneCommand: true,
    queuedResumeIsCancelledByTerminalOrLifecycleInvalidation: true,
    manualPauseReusesExactServicePrivacyGeneration: true,
    privacyGenerationDriftRejectsPrelatchedPauseCheckpoint: true,
    resumeUiWaitsForNativeRecordingOwnership: true,
    recordingPublishesOnlyAfterReadsEnabled: true,
    resumeOpensExactlyOnePostCallChunkBeforeWrites: true,
    invalidRetainedOwnerAllowsOneGenerationBoundRecreation: true,
    stableNormalReleasesSystemPauseDespiteStaleRetainedSilencing: true,
    staleSilencedRetainedRecorderRecreatesExactlyOnce: true,
    newClientSilencingEdgeRevokesInFlightResumeGeneration: true,
    recreatedRecorderWaitsReadDisabledForExactUnsilencing: true,
    callReentryManualPauseTerminalOrStaleCallbackRevokesRecovery: true,
    manualPauseStopsAndReleasesAndNeverAutoResumes: true,
    terminalTombstoneBlocksAutoResumeAfterProcessRestore: true,
    processDeathFinalizesNonManualCaptureThroughDurableStop: true,
    processDeathNeverPublishesPhantomPausedRecorder: true,
    manualPauseRemainsUserResumableAfterProcessDeath: true,
    noCommunicationAudioPersisted: true,
  },
  physicalTest3Required: true,
  physicalCriterion: 'Rejected or short calls require measured bounded unattended recovery while execution remains available; answered locked calls require preserved audio plus recovery on the first permitted wake.',
});
assert.deepEqual(plan.postInstallQualification.iosCallInterruptionSafety, {
  sourceContract: 'scripts/fixtures/MainaIOSCallRecoveryPolicyTests.swift',
  nativeVerifier: 'scripts/verify-ios-native-recorder.mjs',
  requiredSourceTruths: {
    cannotInterruptOthersRequiresExactDomainAndCode: true,
    platformHoldRetainsOneCoalescedPendingGeneration: true,
    manualResumeDuringSystemPauseQueuesRecoveryWithoutClaimingRecording: true,
    callKitCurrentStateIsAuthoritative: true,
    stopSaveAbortWinsOverEveryRecoveryCallback: true,
    postCallRecoveryBudgetStartsAtAttemptZero: true,
    recursiveAttemptsPreserveOneLoopClock: true,
    laterPublicSignalStartsFreshBoundedLoop: true,
    platformHoldBackgroundExhaustionWaitsForPublicSignal: true,
    interruptionBridgeAcquiredBeforePotentialSuspension: true,
    duplicateInterruptionSignalsCoalesceOneBridgePerCycle: true,
    bridgeExpirationRetainsOnePendingPublicWakeGeneration: true,
    backgroundAssertionAcquiredBeforeChunkFinalization: true,
    backgroundExpirationReturnsAssertionBeforeAsyncJournal: true,
    staleBackgroundExpirationCannotRevokeNewerRecovery: true,
    eachSuccessfulRecoveryOpensExactlyOneChunk: true,
    manualPauseRemainsDistinct: true,
    applicationStateReadsMainThreadIsolated: true,
    fallbackTaskExpirationEndsBeforeAsyncRegistryWork: true,
    recoveryRetryRequiresForegroundOrExactLiveBackgroundLease: true,
  },
  physicalTest3Required: true,
  physicalCriterion: 'Rejected or short calls require measured bounded recovery while execution remains available; answered locked calls require preserved audio plus recovery on the first permitted public wake.',
});

assert.deepEqual(plan.postInstallQualification.iosNativePostProcessingSafety, {
  sourceContracts: [
    'src/services/meetingCaptureLifecycle.ts',
    'src/services/meetingCaptureLifecycle.test.ts',
    'src/data/iosNativePostProcessingImport.test.ts',
  ],
  nativeVerifier: 'scripts/verify-ios-native-recorder.mjs',
  requiredSourceTruths: {
    exactDurableImportFencePreventsDuplicateNativeStart: true,
    terminalAttemptRereadsCommittedMeetingFence: true,
    retainedPostCommitReadbackRepairsPublicStages: true,
    stageRepairIsIdempotentAndNeverDowngradesImportedRun: true,
    stageRepairFailureDoesNotBlockLaterMeetings: true,
    nativeResultAndAudioRemainRetainedUntilAcknowledged: true,
    acknowledgementCasFalsePublishesSanitizedReconciliationPending: true,
    partialAcknowledgementClearsNativePayloadAndRetainsWindowEvidence: true,
    monotonicAudioDurationReadbackMatchesDurableImport: true,
  },
  postInstallCriterion: 'Every imported native run, including a partial result retained after a prior import, must converge to acknowledged payload-clear native state and terminal public ASR/transcript truth on a later foreground wake without reopening native work.',
});

assert.deepEqual(plan.postInstallQualification.androidNativeTerminalSafety, {
  sourceContracts: [
    'src/hardware/recording/saveHandoff.test.ts',
    'modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt',
  ],
  nativeVerifier: 'scripts/verify-native-recorder.mjs',
  requiredInstalledTruths: {
    nativeServiceOwnsFinalizingPublication: true,
    externalPresentationCannotEraseNativeTerminalAuthority: true,
    stopRequiresExactTerminalTokenBeforeFinalizing: true,
    duplicateTerminalRequestsCoalesce: true,
    staleCompletionRequiresNewerOwnerOrLifecycleShutdown: true,
    recoveryRequiredCannotPublishIdleOrAdmitNewCapture: true,
    cleanStopRequiresIdleAndNoNativeLastError: true,
    durableOutboxHandoffPrecedesReady: true,
    failedAbortPreservesMeetingAndAudio: true,
    telemetryUsesSanitizedBoundedReasonCodesOnly: true,
  },
});

for (const relative of [
  'scripts/verify-android-command-surface.mjs',
  'scripts/verify-android-command-surface-emulator.mjs',
  'scripts/maina-button-bridge.sh',
  'scripts/android-soak-monitor.sh',
]) {
  assert.ok(source(relative).length > 0, `${relative} must be present for the Android command-surface gate.`);
}
assert.match(source('modules/maina-recorder/android/src/main/AndroidManifest.xml'), /MainaShellCommandReceiver/);
assert.match(source('modules/maina-recorder/android/src/main/AndroidManifest.xml'), /android:permission="android\.permission\.DUMP"/);
assert.match(source('modules/maina-recorder/android/src/main/AndroidManifest.xml'), /MainaCommandReceiver"[\s\S]*?android:exported="false"/);
assert.match(source('scripts/verify-android-command-surface-emulator.mjs'), /const hostileIdleStabilityMs = 30_000;/);
assert.match(source('scripts/verify-android-command-surface-emulator.mjs'), /result\.preShellIdleStabilityMs = hostileIdleStabilityMs;/);

const androidPolicy = source('modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt');
assert.match(androidPolicy, /system call source path drains without stopping/);
assert.match(androidPolicy, /communication silencing and system drain discard every buffer/);
assert.match(androidPolicy, /system pause leaves stale retained silencing to bounded native recovery after mode normal/);
assert.match(androidPolicy, /stably normal but silenced retained recorder recreates once and never publishes stale ownership/);
assert.match(androidPolicy, /new client silencing edge during system resume reopens communication recovery/);
assert.match(androidPolicy, /recreated-recorder-awaiting-unsilencing/);
assert.match(androidPolicy, /system resume persistence failure stays latched system owned and retry eligible/);
assert.match(androidPolicy, /resume tap coalesces behind an in-flight native pause checkpoint/);
assert.match(androidPolicy, /resume queued behind manual pause reuses the reducer privacy latch/);
assert.match(androidPolicy, /record screen waits for native recording ownership before clearing paused UI/);
assert.match(source('src/core/recording/nativeResumeIntent.test.ts'), /delivers exactly one resume after the visible-Paused bridge window/);
assert.match(source('src/core/recording/nativeResumeIntent.test.ts'), /cancels an outstanding resume on lifecycle invalidation/);
assert.match(source('src/core/recording/nativeResumeIntent.ts'), /class NativeResumeIntentLatch/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /object MainaPrelatchedPausePolicy/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt'), /fun pauseAfterReadsLatched/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /failClosedResumeDurability\(operationOwner\)/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt'), /fun latchSystemDrainNow/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt'), /fun resumeAfterCommunication/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt'), /recreatedRecorderIsWaitingForUnsilencing/);
assert.match(source('src/hardware/recording/saveHandoff.test.ts'), /leaves native finalizing and idle publication/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /object MainaExternalCapturePresentationPolicy/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /nativeStopIsClean/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /outcome\.snapshot\.lastError/);
assert.match(androidPolicy, /process death finalizes every non-manual active phase and never auto resumes/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /process-restored-finalize/);

assert.deepEqual(plan.postInstallQualification.androidPublicIdentityLimitations, {
  stableVisibleMeetingJobSourceIdentities: 'limited',
  logicalOutboxIdentity: 'limited',
  reason: 'The approved Android public accessibility surface exposes an existing clickable meeting card and Notes route, but not a stable meeting/job/source identifier.',
});

for (const relative of [
  'scripts/verify-build-source-state.mjs',
  'scripts/build-android-release-candidate.sh',
  'scripts/install-android-preserving-data.sh',
  'scripts/m0-replay-harness.sh',
  'scripts/verify-release-provenance.mjs',
  'scripts/verify-generated-native-release-metadata.mjs',
]) {
  assert.match(source(relative), /m3-m4-0\.10\.68-candidate-plan\.json/, `${relative} must use the active 0.10.68 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.68-94\.apk/);
assert.match(source('scripts/build-android-release-candidate.sh'), /verify-release-toolchain\.mjs/);
assert.match(source('scripts/build-android-release-candidate.sh'), /artifacts\/apps\/release-build-attempts/);
assert.match(source('scripts/prebuild-android.sh'), /"\$NODE_BIN\/node" "\$EXPO_CLI" prebuild/);
assert.doesNotMatch(source('scripts/prebuild-android.sh'), /\bnpx\s+expo\b/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.68\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
console.log('0.10.68 paired reliability and default-off meeting-tag candidate identity, frozen 0.10.67 evidence, defaults, exact source pins, call-interruption policy, iOS native stage recovery, and native terminal safety verified.');
