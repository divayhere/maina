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

const historicalPlan = json('release/m3-m4-0.10.70-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.70.schema.json');
const plan = json('release/m3-m4-0.10.71-candidate-plan.json');
const schema = json('release/provenance-0.10.71.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-0.10.70-candidate-plan.json'), 'a30719bd88b03efe246f539d932f0ea10df6c4db31dd11fb49d4a48e103ee3fe');
assert.equal(sha256('release/provenance-0.10.70.schema.json'), 'd709fed290f4335473de9a63c3da1f25657a10ae66c3e83dbfd2f4229d6b1b5e');
assert.deepEqual(historicalPlan.release, { version: '0.10.70', androidVersionCode: 96, iosBuildNumber: '52' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.70');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.71');
assert.deepEqual(plan.release, { version: '0.10.71', androidVersionCode: 97, iosBuildNumber: '53' });
assert.equal(plan.sources.android.productCommit, '82797f3f440f6135adb24c103e8cf773b2719cc9');
assert.equal(plan.sources.ios.productCommit, '12f0939711a8b66d27ec2a497979c2e78b9db1a3');
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
const automaticWorkAuthorityProvider = {
  type: 'provider',
  name: 'com.divay.maina.recorder.MainaCaptureAutomaticWorkAuthorityProvider',
  exported: 'false',
  permission: null,
  process: null,
};
assert.deepEqual(plan.toolchains, historicalPlan.toolchains);
assert.deepEqual(plan.buildPolicy, historicalPlan.buildPolicy);

assert.equal(schema.properties.releaseId.const, plan.releaseId);
assert.deepEqual(schema.properties.release.properties, {
  version: { const: plan.release.version },
  androidVersionCode: { const: plan.release.androidVersionCode },
  iosBuildNumber: { const: plan.release.iosBuildNumber },
});
assert.notDeepEqual(schema, historicalSchema, '0.10.71 must retain its recursively closed provenance schema hardening.');

const assertClosedRecordSchemas = (definition, name) => {
  if (!definition || typeof definition !== 'object') return;
  if (definition.type === 'object' && definition.properties) {
    assert.equal(definition.additionalProperties, false, `${name} must reject unknown fields.`);
    assert.deepEqual(
      [...definition.required].sort(),
      Object.keys(definition.properties).sort(),
      `${name} must require its exact declared field set.`,
    );
    for (const [property, propertyDefinition] of Object.entries(definition.properties)) {
      assertClosedRecordSchemas(propertyDefinition, `${name}.${property}`);
    }
  }
  if (definition.items) assertClosedRecordSchemas(definition.items, `${name}[]`);
  for (const keyword of ['oneOf', 'anyOf']) {
    for (const [index, branch] of (definition[keyword] ?? []).entries()) {
      assertClosedRecordSchemas(branch, `${name}.${keyword}[${index}]`);
    }
  }
};
assertClosedRecordSchemas(schema, 'provenance');
for (const [name, definition] of Object.entries(schema.$defs)) {
  assertClosedRecordSchemas(definition, `$defs.${name}`);
}
assert.deepEqual(schema.properties.approval.oneOf, [
  { $ref: '#/$defs/candidateApproval' },
  { $ref: '#/$defs/adminApproval' },
]);
assert.deepEqual(schema.$defs.candidateApproval.properties, {
  status: { const: 'candidate' },
  approvedBy: { type: 'null' },
  approvedAt: { type: 'null' },
});
assert.deepEqual(schema.$defs.adminApproval.required, ['status', 'approvedBy', 'approvedAt', 'authorization']);
assert.equal(schema.$defs.adminApproval.properties.status.const, 'admin-approved');
assert.equal(schema.$defs.adminApproval.properties.authorization.$ref, '#/$defs/ownerAuthorizationReference');
assert.deepEqual(schema.$defs.androidArtifact.required, ['path', 'sha256', 'bytes', 'buildLog', 'inspection', 'audit']);
assert.deepEqual(schema.$defs.iosArtifact.required, ['path', 'sha256', 'bytes', 'buildLog', 'inspection', 'audit', 'debugSymbols']);
assert.equal(schema.allOf[0].then.properties.artifacts.properties.android.$ref, '#/$defs/androidArtifact');
assert.equal(schema.allOf[0].then.properties.artifacts.properties.ios.$ref, '#/$defs/iosArtifact');

assert.equal(app.version, plan.release.version);
assert.equal(app.ios.bundleIdentifier, plan.identity.iosBundleIdentifier);
assert.equal(app.ios.buildNumber, plan.release.iosBuildNumber);
assert.equal(app.android.package, plan.identity.androidPackage);
assert.equal(app.android.versionCode, plan.release.androidVersionCode);
assert.equal(manifest.version, plan.release.version);
assert.equal(lock.version, plan.release.version);
assert.equal(lock.packages[''].version, plan.release.version);
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleShortVersionString<\/key>\s*<string>0\.10\.71<\/string>/);
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleVersion<\/key>\s*<string>53<\/string>/);
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
  schema: 'release/provenance-0.10.71.schema.json',
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

const expectedIosTerminalSourceContracts = [
  'src/core/recording/nativeSaveRecovery.test.ts',
  'modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift',
  'modules/maina-recorder/ios/MainaIOSNativeCaptureTerminalPolicy.swift',
  'scripts/fixtures/MainaIOSNativeCaptureTerminalPolicyTests.swift',
  'scripts/verify-ios-native-recorder.mjs',
];
const assertIosTerminalSafetyContract = (contract) => {
  assert.deepEqual(contract, {
    sourceContracts: expectedIosTerminalSourceContracts,
  nativeVerifier: 'scripts/verify-ios-native-recorder.mjs',
  requiredInstalledTruths: {
    terminalStopOwnsIndependentMonotonicGeneration: true,
    stopRetainsExactRecorderUntilMatchingDelegateCompletion: true,
    staleRecorderOrGenerationCannotCompleteNewerStop: true,
    delegateFailureAndEncodeErrorRemainRecoveryRequired: true,
    boundedTimeoutRetainsRecoveryRequired: true,
    cleanStopRequiresFinalizedReadablePositiveAudio: true,
    terminalReceiptIsSeparateFromLiveMeetingIdentity: true,
    callRecoveryGenerationCannotInvalidateTerminalCompletion: true,
    duplicateCompletionAndTimeoutLoserAreIgnored: true,
    javascriptAcceptsIdleOnlyWithExactCleanTerminalReceipt: true,
  },
  });
  assert.ok(contract.sourceContracts.includes(contract.nativeVerifier), 'The native verifier must be part of its own exact evidence set.');
};
assertIosTerminalSafetyContract(plan.postInstallQualification.iosNativeTerminalSafety);
for (const relative of plan.postInstallQualification.iosNativeTerminalSafety.sourceContracts) {
  assertPinnedBlob(plan.sources.ios.productCommit, relative);
}
assert.throws(
  () => assertIosTerminalSafetyContract({
    ...plan.postInstallQualification.iosNativeTerminalSafety,
    sourceContracts: expectedIosTerminalSourceContracts.filter((relative) => relative !== 'modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift'),
  }),
  /Expected values to be strictly deep-equal/,
);

assert.deepEqual(plan.postInstallQualification.androidRecordingDatabaseAdmission, {
  sourceContracts: [
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaDatabaseWriterCoordinator.kt',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt',
    'modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaDatabaseWriterCoordinatorTest.kt',
    'src/data/db.ts',
    'src/data/dbInitialization.test.ts',
    'src/data/durableWakeTransaction.test.ts',
    'src/data/meetingCreation.test.ts',
    'src/data/meetings.ts',
    'src/services/backgroundPipeline.ts',
    'scripts/verify-native-recorder.mjs',
  ],
  nativeVerifier: 'scripts/verify-native-recorder.mjs',
  requiredInstalledTruths: {
    recordingAdmissionPreemptsQueuedBackgroundWriters: true,
    backgroundTransactionsRollbackAtOperationAndCommitCheckpoints: true,
    databaseInitializationAndMigrationsYieldToRecordingAdmission: true,
    meetingAndInitialPipelineStageCommitAtomically: true,
    nativeModuleTeardownPoisonsOutstandingWriterTokens: true,
    recordingAdmissionUsesOneAbsoluteFifteenSecondDeadline: true,
    successfulCommitIsNotInvertedByCloseFailure: true,
    twoRuntimeDemandCannotBeLostAtJavaScriptBoundary: true,
  },
  postInstallCriterion: 'A cold or warm recording start under concurrent database work must either commit exactly one meeting plus its initial pipeline stage within the bounded admission deadline or fail closed without a partial meeting, while later recording admission remains available.',
});
for (const relative of plan.postInstallQualification.androidRecordingDatabaseAdmission.sourceContracts) {
  assertPinnedBlob(plan.sources.android.productCommit, relative);
}

assert.deepEqual(plan.postInstallQualification.androidNativeTerminalSafety, {
  sourceContracts: [
    'src/app/record.tsx',
    'src/core/recording/nativeSaveRecovery.ts',
    'src/core/recording/nativeSaveRecovery.test.ts',
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
    javascriptWaitsThroughTransientIdleUntilExactDurableTerminalPublication: true,
    durableOutboxHandoffPrecedesReady: true,
    failedAbortPreservesMeetingAndAudio: true,
    telemetryUsesSanitizedBoundedReasonCodesOnly: true,
  },
});
assert.match(source('src/app/record.tsx'), /Platform\.OS === 'android'[\s\S]*?await waitForNativeSaveResolution/);
assert.match(source('src/core/recording/nativeSaveRecovery.ts'), /status\.state === 'idle'[\s\S]*?status\.terminalReasonCode === 'stop_running'/);
assert.match(source('src/core/recording/nativeSaveRecovery.test.ts'), /waits through native idle until the durable Android terminal receipt is published/);

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
const iosLifecycle = source('src/services/meetingCaptureLifecycle.ts');
const iosLifecycleTests = source('src/services/meetingCaptureLifecycle.test.ts');
const iosMeetingStore = source('src/data/meetings.ts');
const iosNativeImportTests = source('src/data/iosNativePostProcessingImport.test.ts');
const iosPostProcessingCore = source('src/services/nativePostProcessingCore.ts');
assert.match(iosLifecycle, /const reconciledMeeting = await getMeeting\(meeting\.id\)/);
assert.match(iosLifecycle, /iOS imported post-processing stage repair retained for retry/);
assert.match(iosLifecycleTests, /repairs public stages when retained readback follows a committed native import/);
assert.match(iosLifecycleTests, /retains a fenced repair failure while advancing a later eligible meeting/);
assert.match(iosMeetingStore, /expectedPersistedAudioDurationMs = Math\.max/);
assert.match(iosMeetingStore, /committed\.audio_duration_ms !== expectedPersistedAudioDurationMs/);
assert.match(iosNativeImportTests, /binds monotonic capture duration when it exceeds the analyzed window duration/);
assert.match(iosPostProcessingCore, /String\(input\.audioDurationMs\)/);

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
  'scripts/qualification/ios-lane.mjs',
  'scripts/m0-replay-harness.sh',
  'scripts/verify-release-provenance.mjs',
  'scripts/verify-generated-native-release-metadata.mjs',
]) {
  assert.match(source(relative), /m3-m4-0\.10\.71-candidate-plan\.json/, `${relative} must use the active 0.10.71 plan.`);
  assert.doesNotMatch(source(relative), /m3-m4-0\.10\.70-candidate-plan\.json/, `${relative} must not use the frozen 0.10.70 plan.`);
}
function assertIosLaneActivePlanBinding(value) {
  assert.equal(
    (value.match(/const activeReleasePlanRelativePath = 'release\/m3-m4-0\.10\.71-candidate-plan\.json';/g) ?? []).length,
    1,
    'iOS qualification must declare exactly one active 0.10.71 plan authority.',
  );
  assert.equal(
    (value.match(/\bactiveReleasePlanRelativePath\b/g) ?? []).length,
    3,
    'iOS qualification must use its active plan authority only for declaration, helper preflight, and runtime loading.',
  );
  assert.match(value, /const helpers = \[[\s\S]*?activeReleasePlanRelativePath,[\s\S]*?\];/);
  assert.match(value, /readFileSync\(join\(projectDir, activeReleasePlanRelativePath\), 'utf8'\)/);
}
const iosLaneSource = source('scripts/qualification/ios-lane.mjs');
assertIosLaneActivePlanBinding(iosLaneSource);
for (const staleVersion of ['0.10.70', '0.10.68', '0.10.67']) {
  assert.throws(
    () => assertIosLaneActivePlanBinding(iosLaneSource.replace('0.10.71-candidate-plan.json', `${staleVersion}-candidate-plan.json`)),
    /active 0\.10\.71 plan authority/,
  );
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.71-97\.apk/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.71-53\.app\.zip/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.71-53\.app\.dSYM\.zip/);
assert.match(source('scripts/build-android-release-candidate.sh'), /verify-release-toolchain\.mjs/);
assert.match(source('scripts/build-android-release-candidate.sh'), /artifacts\/apps\/release-build-attempts/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /verify-release-toolchain\.mjs/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /artifacts\/apps\/release-build-attempts/);
assert.match(source('scripts/prebuild-android.sh'), /"\$NODE_BIN\/node" "\$EXPO_CLI" prebuild/);
assert.doesNotMatch(source('scripts/prebuild-android.sh'), /\bnpx\s+expo\b/);
assert.doesNotMatch(source('scripts/prepare-ios-local.sh'), /\bnpx\s+expo\b/);
assert.match(source('scripts/run-ios-xcuitest-direct.py'), /EXPECTED_VERSION = "0\.10\.71"/);
assert.match(source('scripts/run-ios-xcuitest-direct.py'), /EXPECTED_BUILD = "53"/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.equal((source('scripts/build-ios-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs ios/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.71\.mjs/);
assert.doesNotMatch(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.70\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
assert.match(source('scripts/build-install-ios-staging.sh'), /Refusing combined candidate build\/install/);
assert.match(source('scripts/renew-ios-personal.sh'), /Refusing build-and-install renewal for the active candidate/);
console.log('0.10.71 paired reliability and recording database-admission candidate identity, frozen 0.10.70 evidence, defaults, exact source pins, call-interruption policy, iOS native stage recovery, and native terminal safety verified.');
