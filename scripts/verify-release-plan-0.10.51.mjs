import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');

const historicalPlan = json('release/m3-m4-0.10.50-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.50.schema.json');
const plan = json('release/m3-m4-0.10.51-candidate-plan.json');
const schema = json('release/provenance-0.10.51.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-0.10.50-candidate-plan.json'), 'e7d43c712c751c06a9e7b68212c283ff661264a74f5c227a15b084934c58cedc');
assert.equal(sha256('release/provenance-0.10.50.schema.json'), '77304f8aba65d0731d3d8964d8d066851da33b76651c2f2e973d291917099871');
assert.deepEqual(historicalPlan.release, { version: '0.10.50', androidVersionCode: 76, iosBuildNumber: '32' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.50');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.51');
assert.deepEqual(plan.release, { version: '0.10.51', androidVersionCode: 77, iosBuildNumber: '33' });
assert.equal(plan.sources.android.productCommit, 'cf5a54b407986353360e86a668234db23f315d33');
assert.equal(plan.sources.ios.productCommit, 'b7511244d6dc280befed3b351e5c0ded3b9c94ba');
assert.equal(plan.sources.coordinationCommit, '540779272378b5e1620fb5cab782251ab5b56760');
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
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleShortVersionString<\/key>\s*<string>0\.10\.51<\/string>/);
assert.match(source('ios/Maina/Info.plist'), /<key>CFBundleVersion<\/key>\s*<string>33<\/string>/);
assert.match(source('ios/Maina.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = "?com\.divay\.maina\.staging"?;/);

assert.deepEqual(plan.featureFlagDefaults, {
  mobileMemorySurfaceV1: false,
  mobileCloudMeetingsV1: false,
  mobileFrozenHandoffV1: false,
  mobileMemoryPulseV1: false,
  mobileSavedRecallsV1: false,
  mobileVerifiedLinksV1: false,
  pulseBackgroundPolling: false,
  smartRecallAutomaticExecution: false,
  pulseRefreshMode: 'manual-only',
  smartRecallExecutionMode: 'manual-only',
});
assert.deepEqual(plan.provenancePolicy, {
  schema: 'release/provenance-0.10.51.schema.json',
  initialApproval: { status: 'candidate', approvedBy: null, approvedAt: null },
  requiresBothExactArtifactsBeforeAuthorization: true,
  requiresFreshDualArtifactAndBuildLogRevalidation: true,
});
assert.equal(plan.buildPolicy.requireExactGeneratedNativeMetadata, true);

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
    resumeOpensExactlyOnePostCallChunkBeforeWrites: true,
    invalidRetainedOwnerAllowsOneGenerationBoundRecreation: true,
    callReentryManualPauseTerminalOrStaleCallbackRevokesRecovery: true,
    manualPauseStopsAndReleasesAndNeverAutoResumes: true,
    terminalTombstoneBlocksAutoResumeAfterProcessRestore: true,
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

const iosPolicyTests = source('scripts/fixtures/MainaIOSCallRecoveryPolicyTests.swift');
assert.match(iosPolicyTests, /cannotInterruptOthers must remain a temporary platform hold/);
assert.match(iosPolicyTests, /a long call must receive a fresh post-call recovery budget/);
assert.match(iosPolicyTests, /duplicate public signals must not reset the active loop/);
assert.match(iosPolicyTests, /a later real public signal must start a fresh bounded loop/);
assert.match(source('modules/maina-recorder/ios/MainaIOSCallRecoveryPolicy.swift'), /cannotInterruptOthersDomain/);
assert.match(source('modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift'), /recoveryLoopStartedUptime/);
assert.match(source('src/hardware/recording/saveHandoff.test.ts'), /leaves native finalizing and idle publication/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /object MainaExternalCapturePresentationPolicy/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt'), /nativeStopIsClean/);
assert.match(source('modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt'), /outcome\.snapshot\.lastError/);

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
  assert.match(source(relative), /m3-m4-0\.10\.51-candidate-plan\.json/, `${relative} must use the active 0.10.51 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.51-77\.apk/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.51-33\.app\.zip/);
assert.match(source('scripts/build-ios-release-candidate.sh'), /Maina-0\.10\.51-33\.app\.dSYM\.zip/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.equal((source('scripts/build-ios-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs ios/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.51\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
assert.match(source('scripts/build-install-ios-staging.sh'), /Refusing combined candidate build\/install/);
assert.match(source('scripts/renew-ios-personal.sh'), /Refusing build-and-install renewal for the active candidate/);
console.log('0.10.51 paired Test 3 candidate identity, frozen 0.10.50 evidence, defaults, exact source pins, call-interruption policy, and native terminal safety verified.');
