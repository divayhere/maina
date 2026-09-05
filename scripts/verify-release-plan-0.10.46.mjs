import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');

const historicalPlan = json('release/m3-m4-0.10.45-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.45.schema.json');
const plan = json('release/m3-m4-0.10.46-candidate-plan.json');
const schema = json('release/provenance-0.10.46.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-0.10.45-candidate-plan.json'), '58b1339c2cc019cc74b55f648ac1bcf48bda12232fdff641f40b5f1dbbf7010c');
assert.equal(sha256('release/provenance-0.10.45.schema.json'), 'bb169c13a330cc792638047ba36b449b416a34b7415f09396ada7833f4758308');
assert.deepEqual(historicalPlan.release, { version: '0.10.45', androidVersionCode: 71, iosBuildNumber: '27' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.45');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.46');
assert.deepEqual(plan.release, { version: '0.10.46', androidVersionCode: 72, iosBuildNumber: '28' });
assert.equal(plan.sources.android.productCommit, '9a11e9558437ea0128e77f9b800b2df108c7a8ab');
assert.equal(plan.sources.ios.productCommit, '6f0a23a4321411e03146f423cedc24eabb75f989');
assert.equal(historicalPlan.sources.coordinationCommit, 'ea829f7e9d0cf788bb8477bcfaab9ef519686a27');
assert.equal(plan.sources.coordinationCommit, 'fb972b00571a1be29351da022521aabbc781ec4b');
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
assert.equal(app.android.package, plan.identity.androidPackage);
assert.equal(app.android.versionCode, plan.release.androidVersionCode);
assert.equal(manifest.version, plan.release.version);
assert.equal(lock.version, plan.release.version);
assert.equal(lock.packages[''].version, plan.release.version);
assert.match(source('android/app/build.gradle'), /versionCode 72/);
assert.match(source('android/app/build.gradle'), /versionName "0\.10\.46"/);
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
  schema: 'release/provenance-0.10.46.schema.json',
  initialApproval: { status: 'candidate', approvedBy: null, approvedAt: null },
  requiresBothExactArtifactsBeforeAuthorization: true,
  requiresFreshDualArtifactAndBuildLogRevalidation: true,
});
assert.equal(plan.buildPolicy.requireExactGeneratedNativeMetadata, true);

const drawer = plan.postInstallQualification.drawerAccessibility;
assert.equal(drawer.sourceContract, 'src/design/shell.accessibility.test.mjs');
assert.equal(drawer.openMenuLabel, 'Open menu');
assert.equal(drawer.closeMenuLabel, 'Close menu');
assert.deepEqual(drawer.requiredDefaultOffDestinationButtons, [
  { label: 'Settings', route: '/settings' },
  { label: 'Privacy & storage', route: '/settings' },
  { label: 'Help', route: '/help' },
  { label: 'Send feedback', route: 'mailto:hello@maina.app?subject=Maina%20feedback' },
]);
assert.deepEqual(drawer.conditionalDestinationButtons, [
  { label: 'Memory', route: '/memory', requiresFlag: 'mobileMemorySurfaceV1' },
]);
assert.match(drawer.requiredSemantics, /Settings must be both named and clickable/);
assert.deepEqual(plan.postInstallQualification.androidCallInterruptionSafety, {
  sourceContract: 'modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt',
  nativeVerifier: 'scripts/verify-native-recorder.mjs',
  requiredInstalledTruths: {
    communicationActivePausesAndLatchesPcmPersistence: true,
    communicationClearAutoResumesSystemOwnedPause: true,
    manualPauseNeverAutoResumes: true,
    terminalStopOrAbortCancelsPendingResume: true,
    terminalTombstoneBlocksAutoResumeAfterProcessRestore: true,
    noCommunicationAudioPersisted: true,
  },
  physicalTest3Required: true,
});
assert.deepEqual(plan.postInstallQualification.iosCallInterruptionSafety, {
  sourceContract: 'scripts/fixtures/MainaIOSCallRecoveryPolicyTests.swift',
  nativeVerifier: 'scripts/verify-ios-native-recorder.mjs',
  requiredSourceTruths: {
    callKitObserverRefreshOverridesStaleCachedCommunicationState: true,
    activeObservedCallVetoesRecovery: true,
    endedOrRejectedCallStartsUnattendedRecovery: true,
    manualPauseNeverAutoResumes: true,
    duplicateRecoverySignalsCoalesce: true,
  },
  physicalTest3Required: true,
});

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
  assert.match(source(relative), /m3-m4-0\.10\.46-candidate-plan\.json/, `${relative} must use the active 0.10.46 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.46-72\.apk/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.46\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
console.log('0.10.46 paired call-recovery candidate identity, frozen 0.10.45 evidence plan, defaults, call-interruption truth, and drawer qualification policy verified.');
