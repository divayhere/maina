import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const json = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
const source = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(source(relative)).digest('hex');

const historicalPlan = json('release/m3-m4-candidate-plan.json');
const historicalSchema = json('release/provenance.schema.json');
const plan = json('release/m3-m4-0.10.43-candidate-plan.json');
const schema = json('release/provenance-0.10.43.schema.json');
const app = json('app.json').expo;
const manifest = json('package.json');
const lock = json('package-lock.json');

assert.equal(sha256('release/m3-m4-candidate-plan.json'), 'f3167d5316d22efe20af2482cd020dfb40c6fbcad2a4d2640aa9ae4fd43f97f0');
assert.equal(sha256('release/provenance.schema.json'), 'ce3a10b7652321e4883e0c1659b83497776ed0469f087551b039e48f5aebf284');
assert.deepEqual(historicalPlan.release, { version: '0.10.42', androidVersionCode: 68, iosBuildNumber: '24' });
assert.equal(historicalSchema.properties.releaseId.const, 'maina-m3-m4-0.10.42');

assert.equal(plan.releaseId, 'maina-m3-m4-0.10.43');
assert.deepEqual(plan.release, { version: '0.10.43', androidVersionCode: 69, iosBuildNumber: '25' });
assert.equal(plan.sources.android.productCommit, 'bf8fbd9f31bc11185a6e9f34be3a4e135c770f9b');
assert.equal(plan.sources.ios.productCommit, '5bb0223364ce135c662f8fad507f82138844e1b2');
assert.equal(plan.identity.androidPackage, 'com.divay.maina');
assert.equal(plan.identity.iosBundleIdentifier, 'com.divay.maina.staging');
assert.equal(plan.identity.iosTeamId, '9X4X3R4KCN');
assert.equal(schema.properties.releaseId.const, plan.releaseId);
assert.deepEqual(schema.properties.release.properties, {
  version: { const: plan.release.version },
  androidVersionCode: { const: plan.release.androidVersionCode },
  iosBuildNumber: { const: plan.release.iosBuildNumber },
});

assert.equal(app.version, plan.release.version);
assert.equal(app.android.package, plan.identity.androidPackage);
assert.equal(app.android.versionCode, plan.release.androidVersionCode);
assert.equal(manifest.version, plan.release.version);
assert.equal(lock.version, plan.release.version);
assert.equal(lock.packages[''].version, plan.release.version);
assert.match(source('android/app/build.gradle'), /versionCode 69/);
assert.match(source('android/app/build.gradle'), /versionName "0\.10\.43"/);
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
  schema: 'release/provenance-0.10.43.schema.json',
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
  assert.match(source(relative), /m3-m4-0\.10\.43-candidate-plan\.json/, `${relative} must use the active 0.10.43 plan.`);
}
assert.match(source('scripts/build-android-release-candidate.sh'), /Maina-0\.10\.43-69\.apk/);
assert.equal((source('scripts/build-android-release-candidate.sh').match(/verify-generated-native-release-metadata\.mjs android/g) ?? []).length, 2);
console.log('0.10.43 release candidate identity, frozen 0.10.42 evidence plan, defaults, and drawer qualification policy verified.');
