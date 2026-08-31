#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authorizeExactArtifact,
  qualifyExactArtifact,
  replayConfig,
  sha256File,
  validateApprovedRelease,
} from './lib/release-provenance-core.mjs';

const root = path.resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(path.join(root, 'release/m3-m4-candidate-plan.json'), 'utf8'));
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
  packageName: 'com.divay.maina', versionName: '0.10.42', versionCode: 68,
  releaseSigned: true, signerCertificateSha256: plan.artifactPolicy.android.signerCertificateSha256, debuggable: false, profileable: false,
  permissionsExact: true, componentsExact: true, exportedBoundariesExact: true,
  permissions: structuredClone(plan.artifactPolicy.android.permissions),
  components: structuredClone(plan.artifactPolicy.android.components),
  abis: ['arm64-v8a'],
  jniLibraries: { 'libonnxruntime.so': hash, 'libsherpa-onnx-jni.so': hash },
  vadModelSha256: 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20',
  modelChecksums: { 'assets/silero_vad.int8.onnx': hash }, contentsManifestSha256: hash,
};
const iosAudit = {
  bundleIdentifier: 'com.divay.maina.staging', version: '0.10.42', buildNumber: '24',
  architectures: ['arm64'], signatureValid: true, teamId: '9X4X3R4KCN',
  designatedRequirement: plan.artifactPolicy.ios.designatedRequirement,
  entitlementsExact: true, entitlementsSha256: hash,
  entitlements: structuredClone(plan.artifactPolicy.ios.appEntitlements),
  profileEntitlements: structuredClone(plan.artifactPolicy.ios.profileEntitlements),
  profile: { uuid, name: plan.artifactPolicy.ios.profileName, teamId: '9X4X3R4KCN', expiresAt: '2026-09-07T00:00:00Z', sufficientWindow: true },
  appUuid: uuid, dsymUuid: uuid, appContentsManifestSha256: hash, appBundleSha256: hash,
};

function provenance() {
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
    approval: { status: 'admin-approved', approvedBy: 'Admin', approvedAt: '2026-08-31T12:00:00Z' },
  };
}

try {
  const valid = provenance();
  assert.equal(validateApprovedRelease(valid, plan), true);
  assert.equal(authorizeExactArtifact({ provenance: valid, plan, platform: 'android', artifactPath: valid.artifacts.android.path }), true);
  assert.deepEqual(replayConfig(valid, plan), {
    androidPackage: 'com.divay.maina', androidVersion: '0.10.42', androidVersionCode: '68',
    iosBundleIdentifier: 'com.divay.maina.staging', iosVersion: '0.10.42', iosBuildNumber: '24',
  });

  const candidate = provenance();
  candidate.approval = { status: 'candidate', approvedBy: null, approvedAt: null };
  assert.equal(qualifyExactArtifact({
    provenance: candidate, plan, platform: 'android', artifactPath: candidate.artifacts.android.path,
    buildLogPath: candidate.artifacts.android.buildLog.path,
  }), true);
  assert.throws(() => replayConfig(candidate, plan), /admin-approved/);
  const nullArtifact = provenance();
  nullArtifact.artifacts.ios = null;
  assert.throws(() => replayConfig(nullArtifact, plan), /artifacts\.ios/);
  const sourceDrift = provenance();
  sourceDrift.sources.ios.upstreamCommit = '3'.repeat(40);
  assert.throws(() => validateApprovedRelease(sourceDrift, plan), /finalCommit/);
  const releaseDrift = provenance();
  releaseDrift.release.androidVersionCode = 69;
  assert.throws(() => validateApprovedRelease(releaseDrift, plan), /androidVersionCode/);
  const noActor = provenance();
  noActor.approval.approvedBy = null;
  assert.throws(() => validateApprovedRelease(noActor, plan), /approvedBy/);

  const nonSelectedArtifactTamper = provenance();
  writeFileSync(nonSelectedArtifactTamper.artifacts.ios.path, 'replaced-ios-artifact');
  assert.throws(
    () => authorizeExactArtifact({ provenance: nonSelectedArtifactTamper, plan, platform: 'android', artifactPath: nonSelectedArtifactTamper.artifacts.android.path }),
    /artifacts\.ios\.(bytes|sha256)/,
  );
  const nonSelectedLogTamper = provenance();
  writeFileSync(nonSelectedLogTamper.artifacts.ios.buildLog.path, 'replaced-ios-build-log');
  assert.throws(() => replayConfig(nonSelectedLogTamper, plan), /artifacts\.ios\.buildLog\.(bytes|sha256)/);
  const inspectionTamper = provenance();
  const inspection = JSON.parse(readFileSync(inspectionTamper.artifacts.android.inspection.path, 'utf8'));
  inspection.audit.debuggable = true;
  writeFileSync(inspectionTamper.artifacts.android.inspection.path, JSON.stringify(inspection));
  inspectionTamper.artifacts.android.inspection.bytes = statSync(inspectionTamper.artifacts.android.inspection.path).size;
  inspectionTamper.artifacts.android.inspection.sha256 = sha256File(inspectionTamper.artifacts.android.inspection.path);
  assert.throws(() => validateApprovedRelease(inspectionTamper, plan), /must equal the audit derived/);

  const unexpectedPermission = provenance();
  unexpectedPermission.artifacts.android.audit.permissions.push('android.permission.READ_CONTACTS');
  assert.throws(() => validateApprovedRelease(unexpectedPermission, plan), /artifacts\.android\.audit\.permissions/);
  const unexpectedComponent = provenance();
  unexpectedComponent.artifacts.android.audit.components.push({ type: 'receiver', name: 'UnexpectedReceiver', exported: 'true', permission: null, process: null });
  assert.throws(() => validateApprovedRelease(unexpectedComponent, plan), /artifacts\.android\.audit\.components/);
  const unexpectedEntitlement = provenance();
  unexpectedEntitlement.artifacts.ios.audit.entitlements['com.apple.developer.healthkit'] = true;
  assert.throws(() => validateApprovedRelease(unexpectedEntitlement, plan), /artifacts\.ios\.audit\.entitlements/);
  const dsymTamper = provenance();
  writeFileSync(dsymTamper.artifacts.ios.debugSymbols.path, 'replaced-dsym');
  assert.throws(() => replayConfig(dsymTamper, plan), /artifacts\.ios\.debugSymbols\.(bytes|sha256)/);
  const dsymMismatch = provenance();
  dsymMismatch.artifacts.ios.debugSymbols.uuid = '11111111-2222-3333-4444-555555555555';
  assert.throws(() => validateApprovedRelease(dsymMismatch, plan), /debugSymbols\.uuid/);

  const inspectorSource = readFileSync(path.join(root, 'scripts/inspect-exact-artifact.mjs'), 'utf8');
  for (const token of ['aapt2', 'apksigner', 'AndroidManifest.xml', 'codesign', "'--entitlements', ':-'", 'embedded.mobileprovision', 'dwarfdump', '.dSYM']) {
    assert.ok(inspectorSource.includes(token), `Exact inspector is missing ${token}`);
  }
  console.log('Release provenance, dual-artifact freshness, inspection binding, and replay authorization verified.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
