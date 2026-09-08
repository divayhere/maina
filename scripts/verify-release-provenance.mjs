#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OWNER_RELEASE_AUTHORIZATION_SCOPE,
  authorizeExactArtifact,
  qualifyExactArtifact,
  replayConfig,
  sha256File,
  validateApprovedRelease,
} from './lib/release-provenance-core.mjs';

const root = path.resolve(import.meta.dirname, '..');
const planPath = path.join(root, 'release/m3-m4-0.10.57-candidate-plan.json');
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const planSha256 = sha256File(planPath);
const temporary = mkdtempSync(path.join(tmpdir(), 'maina-release-provenance-'));
const hash = 'a'.repeat(64);
const uuid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

function write(name, contents) {
  const file = path.join(temporary, name);
  writeFileSync(file, contents);
  return file;
}

function artifactRecord(platform, audit) {
  const artifactPath = write(`${platform}.artifact`, `${platform}-signed-artifact`);
  const buildLogPath = write(`${platform}.build.log`, `${platform}-build-log`);
  const artifact = {
    path: artifactPath,
    sha256: sha256File(artifactPath),
    bytes: statSync(artifactPath).size,
    buildLog: { path: buildLogPath, sha256: sha256File(buildLogPath), bytes: statSync(buildLogPath).size },
    inspection: null,
    audit: structuredClone(audit),
  };
  if (platform === 'ios') {
    const symbolsPath = write('ios.dsym.zip', 'ios-debug-symbols');
    artifact.debugSymbols = {
      path: symbolsPath,
      sha256: sha256File(symbolsPath),
      bytes: statSync(symbolsPath).size,
      uuid: artifact.audit.dsymUuid,
    };
  }
  const inspectionPath = write(`${platform}.inspection.json`, `${JSON.stringify({
    schemaVersion: 'maina.exact-artifact-inspection.v1', platform,
    artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes },
    ...(platform === 'ios' ? {
      debugSymbols: {
        path: artifact.debugSymbols.path,
        sha256: artifact.debugSymbols.sha256,
        bytes: artifact.debugSymbols.bytes,
      },
    } : {}),
    audit: artifact.audit,
  })}\n`);
  artifact.inspection = {
    path: inspectionPath,
    sha256: sha256File(inspectionPath),
    bytes: statSync(inspectionPath).size,
    command: 'scripts/inspect-exact-artifact.mjs',
  };
  return artifact;
}

const androidAudit = {
  packageName: plan.identity.androidPackage, versionName: plan.release.version, versionCode: plan.release.androidVersionCode,
  releaseSigned: true, signerCertificateSha256: plan.artifactPolicy.android.signerCertificateSha256, debuggable: false, profileable: false,
  permissionsExact: true, componentsExact: true, exportedBoundariesExact: true,
  permissions: structuredClone(plan.artifactPolicy.android.permissions),
  components: structuredClone(plan.artifactPolicy.android.components),
  abis: ['arm64-v8a'],
  jniLibraries: { 'libonnxruntime.so': hash, 'libsherpa-onnx-jni.so': hash },
  vadModelSha256: 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20',
  modelChecksums: { 'assets/silero_vad.int8.onnx': hash }, contentsManifestSha256: hash,
  inspectionTools: { aapt2: '36.0.0', apksigner: '36.0.0', unzip: 'test' },
};
const iosAudit = {
  bundleIdentifier: plan.identity.iosBundleIdentifier, version: plan.release.version, buildNumber: plan.release.iosBuildNumber,
  architectures: ['arm64'], signatureValid: true, teamId: '9X4X3R4KCN',
  designatedRequirement: plan.artifactPolicy.ios.designatedRequirement,
  entitlementsExact: true, entitlementsSha256: hash,
  entitlements: structuredClone(plan.artifactPolicy.ios.appEntitlements),
  profileEntitlements: structuredClone(plan.artifactPolicy.ios.profileEntitlements),
  profile: { uuid, name: plan.artifactPolicy.ios.profileName, teamId: '9X4X3R4KCN', expiresAt: '2026-09-07T00:00:00Z', sufficientWindow: true },
  appUuid: uuid, dsymUuid: uuid, appContentsManifestSha256: hash, appBundleSha256: hash,
  inspectionTools: { codesign: 'test', security: 'test', dwarfdump: 'test', ditto: 'test' },
};

function candidateProvenance() {
  const finalAndroid = '1'.repeat(40);
  const finalIos = '2'.repeat(40);
  return {
    schemaVersion: 'maina.release-provenance.v1', releaseId: plan.releaseId,
    release: structuredClone(plan.release),
    sources: {
      android: { ...plan.sources.android, finalCommit: finalAndroid, upstreamCommit: finalAndroid },
      ios: { ...plan.sources.ios, finalCommit: finalIos, upstreamCommit: finalIos },
      coordinationCommit: plan.sources.coordinationCommit,
      backendSourceCommit: plan.sources.backendSourceCommit,
      backendProductionDeployment: plan.sources.backendProductionDeployment,
    },
    toolchains: {
      node: 'v24.7.0', expo: '57.0.18', reactNative: '0.86.3',
      android: { jdk: '17.0.16', gradle: '9.3.1', buildTools: '36.0.0', compileSdk: 36, targetSdk: 36 },
      ios: { xcode: '26.4', cocoaPods: '1.17.0', swift: '6.2' },
    },
    featureFlagDefaults: structuredClone(plan.featureFlagDefaults),
    artifacts: { android: artifactRecord('android', androidAudit), ios: artifactRecord('ios', iosAudit) },
    approval: { status: 'candidate', approvedBy: null, approvedAt: null },
  };
}

function approveCandidate(candidate, mutateEnvelope = null) {
  const directive = 'Owner authorizes this exact local staging release for preserving-data installs and automated qualification on Android and iOS.';
  const envelope = {
    schemaVersion: 'maina.owner-release-authorization.v1',
    authorizationId: 'maina-0.10.57-owner-direct-test',
    authorizedBy: 'owner-direct',
    sourceThreadId: '01a048c0-82f8-7183-ac1b-0c9cdad6f2d4',
    directive,
    directiveSha256: createHash('sha256').update(directive).digest('hex'),
    releaseId: candidate.releaseId,
    planSha256,
    candidateProvenanceSha256: createHash('sha256').update(`${JSON.stringify(candidate, null, 2)}\n`).digest('hex'),
    artifactSha256: {
      android: candidate.artifacts.android.sha256,
      ios: candidate.artifacts.ios.sha256,
    },
    scope: [...OWNER_RELEASE_AUTHORIZATION_SCOPE],
    issuedAt: '2026-08-31T12:00:00Z',
    nonce: '11111111-2222-4333-8444-555555555555',
  };
  mutateEnvelope?.(envelope);
  const authorizationPath = write('owner-release-authorization.json', `${JSON.stringify(envelope, null, 2)}\n`);
  chmodSync(authorizationPath, 0o600);
  const approved = structuredClone(candidate);
  approved.approval = {
    status: 'admin-approved',
    approvedBy: envelope.authorizedBy,
    approvedAt: envelope.issuedAt,
    authorization: {
      path: authorizationPath,
      sha256: sha256File(authorizationPath),
      bytes: statSync(authorizationPath).size,
      authorizationId: envelope.authorizationId,
      directiveSha256: envelope.directiveSha256,
      planSha256: envelope.planSha256,
      candidateProvenanceSha256: envelope.candidateProvenanceSha256,
      androidArtifactSha256: envelope.artifactSha256.android,
      iosArtifactSha256: envelope.artifactSha256.ios,
      scope: [...envelope.scope],
      nonce: envelope.nonce,
      issuedAt: envelope.issuedAt,
    },
  };
  return approved;
}

function provenance() {
  return approveCandidate(candidateProvenance());
}

try {
  const valid = provenance();
  assert.equal(validateApprovedRelease(valid, plan, { planSha256 }), true);
  assert.equal(authorizeExactArtifact({ provenance: valid, plan, platform: 'android', artifactPath: valid.artifacts.android.path, planSha256 }), true);
  assert.deepEqual(replayConfig(valid, plan, { planSha256 }), {
    androidPackage: plan.identity.androidPackage, androidVersion: plan.release.version, androidVersionCode: String(plan.release.androidVersionCode),
    iosBundleIdentifier: plan.identity.iosBundleIdentifier, iosVersion: plan.release.version, iosBuildNumber: plan.release.iosBuildNumber,
  });

  const generatorCandidate = candidateProvenance();
  const generatorAuthorized = approveCandidate(generatorCandidate);
  const generatorCandidatePath = write('generator-candidate.json', `${JSON.stringify(generatorCandidate, null, 2)}\n`);
  const generatorOutputPath = path.join(temporary, 'generator-approved.json');
  const generatorResult = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-owner-approved-provenance.mjs'),
    planPath,
    generatorCandidatePath,
    generatorAuthorized.approval.authorization.path,
    generatorOutputPath,
  ], { encoding: 'utf8' });
  assert.equal(generatorResult.status, 0, generatorResult.stderr);
  assert.equal(validateApprovedRelease(JSON.parse(readFileSync(generatorOutputPath, 'utf8')), plan, { planSha256 }), true);
  const secondGeneratorOutputPath = path.join(temporary, 'generator-approved-second.json');
  writeFileSync(secondGeneratorOutputPath, 'occupied');
  const occupiedResult = spawnSync(process.execPath, [
    path.join(root, 'scripts/generate-owner-approved-provenance.mjs'),
    planPath,
    generatorCandidatePath,
    generatorAuthorized.approval.authorization.path,
    secondGeneratorOutputPath,
  ], { encoding: 'utf8' });
  assert.notEqual(occupiedResult.status, 0);

  const candidate = candidateProvenance();
  assert.equal(qualifyExactArtifact({
    provenance: candidate, plan, platform: 'android', artifactPath: candidate.artifacts.android.path,
    buildLogPath: candidate.artifacts.android.buildLog.path, planSha256,
  }), true);
  const candidateActor = candidateProvenance();
  candidateActor.approval.approvedBy = 'self-issued';
  assert.throws(() => qualifyExactArtifact({
    provenance: candidateActor, plan, platform: 'android', artifactPath: candidateActor.artifacts.android.path,
    buildLogPath: candidateActor.artifacts.android.buildLog.path, planSha256,
  }), /approval\.approvedBy/);
  assert.throws(() => replayConfig(candidate, plan, { planSha256 }), /admin-approved/);
  const nullArtifact = provenance();
  nullArtifact.artifacts.ios = null;
  assert.throws(() => replayConfig(nullArtifact, plan, { planSha256 }), /artifacts\.ios/);
  const sourceDrift = provenance();
  sourceDrift.sources.ios.upstreamCommit = '3'.repeat(40);
  assert.throws(() => validateApprovedRelease(sourceDrift, plan, { planSha256 }), /finalCommit/);
  const releaseDrift = provenance();
  releaseDrift.release.androidVersionCode = plan.release.androidVersionCode + 1;
  assert.throws(() => validateApprovedRelease(releaseDrift, plan, { planSha256 }), /androidVersionCode/);
  const noActor = provenance();
  noActor.approval.approvedBy = null;
  assert.throws(() => validateApprovedRelease(noActor, plan, { planSha256 }), /approvedBy/);

  const nonSelectedArtifactTamper = provenance();
  writeFileSync(nonSelectedArtifactTamper.artifacts.ios.path, 'replaced-ios-artifact');
  assert.throws(
    () => authorizeExactArtifact({ provenance: nonSelectedArtifactTamper, plan, platform: 'android', artifactPath: nonSelectedArtifactTamper.artifacts.android.path, planSha256 }),
    /artifacts\.ios\.(bytes|sha256)/,
  );
  const nonSelectedLogTamper = provenance();
  writeFileSync(nonSelectedLogTamper.artifacts.ios.buildLog.path, 'replaced-ios-build-log');
  assert.throws(() => replayConfig(nonSelectedLogTamper, plan, { planSha256 }), /artifacts\.ios\.buildLog\.(bytes|sha256)/);
  let inspectionTamper = candidateProvenance();
  const inspection = JSON.parse(readFileSync(inspectionTamper.artifacts.android.inspection.path, 'utf8'));
  inspection.audit.debuggable = true;
  writeFileSync(inspectionTamper.artifacts.android.inspection.path, JSON.stringify(inspection));
  inspectionTamper.artifacts.android.inspection.bytes = statSync(inspectionTamper.artifacts.android.inspection.path).size;
  inspectionTamper.artifacts.android.inspection.sha256 = sha256File(inspectionTamper.artifacts.android.inspection.path);
  inspectionTamper = approveCandidate(inspectionTamper);
  assert.throws(() => validateApprovedRelease(inspectionTamper, plan, { planSha256 }), /must equal the audit derived/);

  const unexpectedPermission = provenance();
  unexpectedPermission.artifacts.android.audit.permissions.push('android.permission.READ_CONTACTS');
  assert.throws(() => validateApprovedRelease(unexpectedPermission, plan, { planSha256 }), /artifacts\.android\.audit\.permissions/);
  const unexpectedComponent = provenance();
  unexpectedComponent.artifacts.android.audit.components.push({ type: 'receiver', name: 'UnexpectedReceiver', exported: 'true', permission: null, process: null });
  assert.throws(() => validateApprovedRelease(unexpectedComponent, plan, { planSha256 }), /artifacts\.android\.audit\.components/);
  const unexpectedEntitlement = provenance();
  unexpectedEntitlement.artifacts.ios.audit.entitlements['com.apple.developer.healthkit'] = true;
  assert.throws(() => validateApprovedRelease(unexpectedEntitlement, plan, { planSha256 }), /artifacts\.ios\.audit\.entitlements/);
  const dsymTamper = provenance();
  writeFileSync(dsymTamper.artifacts.ios.debugSymbols.path, 'replaced-dsym');
  assert.throws(() => replayConfig(dsymTamper, plan, { planSha256 }), /artifacts\.ios\.debugSymbols\.(bytes|sha256)/);
  const dsymMismatch = provenance();
  dsymMismatch.artifacts.ios.debugSymbols.uuid = '11111111-2222-3333-4444-555555555555';
  assert.throws(() => validateApprovedRelease(dsymMismatch, plan, { planSha256 }), /debugSymbols\.uuid/);

  const arbitrarySelfAssertion = provenance();
  arbitrarySelfAssertion.approval.approvedBy = 'arbitrary self-assertion';
  assert.throws(() => validateApprovedRelease(arbitrarySelfAssertion, plan, { planSha256 }), /approval\.approvedBy/);
  const wrongPlanAuthorization = provenance();
  wrongPlanAuthorization.approval.authorization.planSha256 = 'b'.repeat(64);
  assert.throws(() => validateApprovedRelease(wrongPlanAuthorization, plan, { planSha256 }), /approval\.authorization\.planSha256/);
  const wrongCandidateAuthorization = provenance();
  wrongCandidateAuthorization.approval.authorization.candidateProvenanceSha256 = 'b'.repeat(64);
  assert.throws(() => validateApprovedRelease(wrongCandidateAuthorization, plan, { planSha256 }), /approval\.authorization\.candidateProvenanceSha256/);
  const envelopeExtra = provenance();
  const envelope = JSON.parse(readFileSync(envelopeExtra.approval.authorization.path, 'utf8'));
  envelope.unexpected = true;
  writeFileSync(envelopeExtra.approval.authorization.path, `${JSON.stringify(envelope, null, 2)}\n`);
  envelopeExtra.approval.authorization.bytes = statSync(envelopeExtra.approval.authorization.path).size;
  envelopeExtra.approval.authorization.sha256 = sha256File(envelopeExtra.approval.authorization.path);
  assert.throws(() => validateApprovedRelease(envelopeExtra, plan, { planSha256 }), /ownerAuthorization/);

  for (const [field, mutate] of [
    ['provenance', (value) => { value.unexpected = true; }],
    ['release', (value) => { value.release.unexpected = true; }],
    ['sourcePin', (value) => { value.sources.android.unexpected = true; }],
    ['toolchain', (value) => { value.toolchains.ios.unexpected = true; }],
    ['artifact', (value) => { value.artifacts.android.unexpected = true; }],
    ['buildLog', (value) => { value.artifacts.android.buildLog.unexpected = true; }],
    ['inspection', (value) => { value.artifacts.android.inspection.unexpected = true; }],
    ['audit', (value) => { value.artifacts.android.audit.unexpected = true; }],
    ['profile', (value) => { value.artifacts.ios.audit.profile.unexpected = true; }],
    ['approval', (value) => { value.approval.unexpected = true; }],
  ]) {
    const injected = provenance();
    mutate(injected);
    assert.throws(() => validateApprovedRelease(injected, plan, { planSha256 }), /missing or unknown fields/, field);
  }

  const inspectorSource = readFileSync(path.join(root, 'scripts/inspect-exact-artifact.mjs'), 'utf8');
  for (const token of ['aapt2', 'apksigner', 'AndroidManifest.xml', 'codesign', "'--entitlements', ':-'", 'embedded.mobileprovision', 'dwarfdump', '.dSYM']) {
    assert.ok(inspectorSource.includes(token), `Exact inspector is missing ${token}`);
  }
  console.log('Release provenance, dual-artifact freshness, inspection binding, and replay authorization verified.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
