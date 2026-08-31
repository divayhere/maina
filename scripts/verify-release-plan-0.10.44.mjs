import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');

const historicalPlan = json('release/m3-m4-0.10.43-candidate-plan.json');
const historicalSchema = json('release/provenance-0.10.43.schema.json');
const plan = json('release/m3-m4-0.10.44-candidate-plan.json');
const schema = json('release/provenance-0.10.44.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-0.10.43-candidate-plan.json'), 'eb2a3db6a5789851519ea7d53e4f065f5185e000f3de7e4d2422f614e1dad60c');
assert.equal(sha256('release/provenance-0.10.43.schema.json'), '4388b00aa9783660fa2814d20e1e092b29f67760a2753429eb99b0c17edaa85b');
assert.deepEqual(historicalPlan.release, { version: '0.10.43', androidVersionCode: 69, iosBuildNumber: '25' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.43');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.44');
assert.deepEqual(plan.release, { version: '0.10.44', androidVersionCode: 70, iosBuildNumber: '26' });
assert.equal(plan.sources.android.productCommit, '557adde0fd88109c62ef556eba4c1c41845c5d7e');
assert.equal(plan.sources.ios.productCommit, '5bb0223364ce135c662f8fad507f82138844e1b2');
assert.equal(historicalPlan.sources.coordinationCommit, 'febe5da858b3196bccde3683e7ba4c21fa500289');
assert.equal(plan.sources.coordinationCommit, '6048d12ae2a6ffb80f97a9873f450e927b04ca4c');
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
assert.match(source('android/app/build.gradle'), /versionCode 70/);
assert.match(source('android/app/build.gradle'), /versionName "0\.10\.44"/);
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
  schema: 'release/provenance-0.10.44.schema.json',
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
  assert.match(source(relative), /m3-m4-0\.10\.44-candidate-plan\.json/, `${relative} must use the active 0.10.44 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.44-70\.apk/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-release-plan-0\.10\.44\.mjs/);
assert.match(manifest.scripts['verify:release-plan-candidate'], /verify-generated-native-release-metadata\.synthetic\.mjs/);
console.log('0.10.44 release candidate identity, frozen 0.10.43 evidence plan, defaults, call-interruption truth, and drawer qualification policy verified.');
