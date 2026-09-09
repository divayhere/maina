import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');

const historicalPlan = json('release/m3-m4-0.10.62-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.62.schema.json');
const plan = json('release/m3-m4-0.10.63-candidate-plan.json');
const schema = json('release/provenance-0.10.63.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-0.10.62-candidate-plan.json'), '63d70922b20671d8ddcbbe252605b5c3fa6b863b9ed24fe502acbefe6d5efe01');
assert.equal(sha256('release/provenance-0.10.62.schema.json'), 'f2449c84b2ef37ca90d88334ad3659f26359ea9df118c7c568952b9c8d48b8db');
assert.deepEqual(historicalPlan.release, { version: '0.10.62', androidVersionCode: 88, iosBuildNumber: '44' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.62');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.63');
assert.deepEqual(plan.release, { version: '0.10.63', androidVersionCode: 89, iosBuildNumber: '45' });
assert.equal(plan.sources.android.productCommit, 'b54b9bd62e4ff554cf5a73c46fc1a20e7eab806f');
assert.equal(plan.sources.ios.productCommit, 'c5bd86d686f5a0b64bcf469c4154ca3864523a06');
assert.equal(plan.sources.coordinationCommit, '1b9c1c631adaba95d2a3f4a347b28db962e2ccc3');
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
assert.deepEqual(plan.toolchains, historicalPlan.toolchains);
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
assert.equal(app.ios.bundleIdentifier, plan.identity.iosBundleIdentifier);
assert.equal(app.ios.buildNumber, plan.release.iosBuildNumber);
assert.equal(app.android.package, plan.identity.androidPackage);
assert.equal(app.android.versionCode, plan.release.androidVersionCode);
assert.equal(manifest.version, plan.release.version);
assert.equal(lock.version, plan.release.version);
assert.equal(lock.packages[''].version, plan.release.version);
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleShortVersionString<\/key>\s*<string>0\.10\.63<\/string>/);
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleVersion<\/key>\s*<string>45<\/string>/);
assert.match(source('ios/Maina.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = "?com\.divay\.maina\.staging"?;/);

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
  schema: 'release/provenance-0.10.63.schema.json',
  initialApproval: { status: 'candidate', approvedBy: null, approvedAt: null },
  requiresBothExactArtifactsBeforeAuthorization: true,
  requiresFreshDualArtifactAndBuildLogRevalidation: true,
});
assert.equal(plan.buildPolicy.requireExactGeneratedNativeMetadata, true);

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
  },
  physicalTest3Required: true,
  physicalCriterion: 'Rejected or short calls require measured bounded recovery while execution remains available; answered locked calls require preserved audio plus recovery on the first permitted public wake.',
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

const androidPolicy = source('modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt');
// This branch binds the exact Android product commit in the paired plan but
// validates only the shared pre-existing Android contracts present locally.
// The Android release line independently validates the newer platform delta.
assert.match(androidPolicy, /system resume persistence failure stays latched system owned and retry eligible/);
assert.match(androidPolicy, /resume tap coalesces behind an in-flight native pause checkpoint/);
assert.match(androidPolicy, /record screen waits for native recording ownership before clearing paused UI/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /failClosedResumeDurability\(operationOwner\)/);
assert.match(source('src/hardware/recording/saveHandoff.test.ts'), /leaves native finalizing and idle publication/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /object MainaExternalCapturePresentationPolicy/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /nativeStopIsClean/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /outcome\.snapshot\.lastError/);
assert.match(androidPolicy, /process death finalizes every non-manual active phase and never auto resumes/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /process-restored-finalize/);

const iosPolicyTests = source('scripts/fixtures/MainaIOSCallRecoveryPolicyTests.swift');
const iosCapture = source('modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift');
assert.match(iosPolicyTests, /cannotInterruptOthers must remain a temporary platform hold/);
assert.match(iosPolicyTests, /a long call must receive a fresh post-call recovery budget/);
assert.match(iosPolicyTests, /duplicate public signals must not reset the active loop/);
assert.match(iosPolicyTests, /a later real public signal must start a fresh bounded loop/);
assert.match(iosPolicyTests, /exact live assertion lease may hand off one pending recovery generation/);
assert.match(source('modules/maina-recorder/ios/MainaIOSCallRecoveryPolicy.swift'), /backgroundExpirationMayApply/);
assert.match(iosCapture, /prepareSystemPause\(reason: "system-interruption"\)/);
assert.match(iosCapture, /completeSystemPause\(reason: "system-interruption"/);
assert.match(iosCapture, /UIApplication\.shared\.endBackgroundTask\(expired\.task\)/);
assert.match(iosCapture, /queue\.async \{ \[weak self\] in/);

assert.deepEqual(plan.postInstallQualification.androidPublicIdentityLimitations, {
  stableVisibleMeetingJobSourceIdentities: 'limited',
  logicalOutboxIdentity: 'limited',
  reason: 'The approved Android public accessibility surface exposes an existing clickable meeting card and Notes route, but not a stable meeting/job/source identifier.',
});

for (const relative of [
  'scripts/verify-build-source-state.mjs',
  'scripts/build-android-release-candidate.sh',
  'scripts/build-ios-release-candidate.sh',
  'scripts/install-android-preserving-data.sh',
  'scripts/install-ios-preserving-data.sh',
  'scripts/m0-replay-harness.sh',
  'scripts/verify-release-provenance.mjs',
  'scripts/verify-generated-native-release-metadata.mjs',
]) {
  assert.match(source(relative), /m3-m4-0\.10\.63-candidate-plan\.json/, `${relative} must use the active 0.10.63 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.63-89\.apk/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.63-45\.app\.zip/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.63-45\.app\.dSYM\.zip/);
assert.match(source('scripts/run-ios-xcuitest-direct.py'), /EXPECTED_VERSION = "0\.10\.63"/);
assert.match(source('scripts/run-ios-xcuitest-direct.py'), /EXPECTED_BUILD = "45"/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.equal((source('scripts/build-ios-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs ios/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.63\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
assert.match(source('scripts/build-install-ios-staging.sh'), /Refusing combined candidate build\/install/);
assert.match(source('scripts/renew-ios-personal.sh'), /Refusing build-and-install renewal for the active candidate/);
console.log('0.10.63 paired reliability and default-off meeting-tag candidate identity, frozen 0.10.62 evidence, defaults, exact source pins, call-interruption policy, and native terminal safety verified.');
