import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function fail(field, message) {
  throw new Error(`${field}: ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'object is required');
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(field, 'non-empty string is required');
  return value;
}

function exact(actual, expected, field) {
  if (actual !== expected) fail(field, `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
}

function match(value, expression, field) {
  string(value, field);
  if (!expression.test(value)) fail(field, `invalid value ${JSON.stringify(value)}`);
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(field, 'positive integer is required');
  return value;
}

function exactArray(actual, expected, field) {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(field, `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function exactJson(actual, expected, field) {
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    fail(field, `expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function sourcePin(actual, planned, field) {
  actual = object(actual, field);
  exact(actual.repository, planned.repository, `${field}.repository`);
  exact(actual.branch, planned.branch, `${field}.branch`);
  exact(actual.productCommit, planned.productCommit, `${field}.productCommit`);
  match(actual.finalCommit, GIT_SHA, `${field}.finalCommit`);
  match(actual.upstreamCommit, GIT_SHA, `${field}.upstreamCommit`);
  exact(actual.finalCommit, actual.upstreamCommit, `${field}.finalCommit`);
}

function featureFlags(actual, planned) {
  actual = object(actual, 'featureFlagDefaults');
  for (const [name, expected] of Object.entries(planned)) {
    exact(actual[name], expected, `featureFlagDefaults.${name}`);
  }
}

function toolchains(actual, planned, platforms) {
  actual = object(actual, 'toolchains');
  match(actual.node, /^v24\.[0-9]+\.[0-9]+$/, 'toolchains.node');
  exact(actual.expo, planned.expo.replace(/^~/, ''), 'toolchains.expo');
  exact(actual.reactNative, planned.reactNative, 'toolchains.reactNative');
  if (platforms.includes('android')) {
    const android = object(actual.android, 'toolchains.android');
    match(android.jdk, /^17(?:\.|$)/, 'toolchains.android.jdk');
    exact(android.gradle, planned.android.gradle, 'toolchains.android.gradle');
    match(android.buildTools, /^[0-9]+(?:\.[0-9]+){2}$/, 'toolchains.android.buildTools');
    exact(android.compileSdk, planned.android.compileSdk, 'toolchains.android.compileSdk');
    exact(android.targetSdk, planned.android.targetSdk, 'toolchains.android.targetSdk');
  }
  if (platforms.includes('ios')) {
    const ios = object(actual.ios, 'toolchains.ios');
    string(ios.xcode, 'toolchains.ios.xcode');
    exact(ios.cocoaPods, planned.ios.cocoaPods, 'toolchains.ios.cocoaPods');
    string(ios.swift, 'toolchains.ios.swift');
  }
}

function commonArtifact(actual, field) {
  actual = object(actual, field);
  string(actual.path, `${field}.path`);
  match(actual.sha256, SHA256, `${field}.sha256`);
  positiveInteger(actual.bytes, `${field}.bytes`);
  const log = object(actual.buildLog, `${field}.buildLog`);
  string(log.path, `${field}.buildLog.path`);
  match(log.sha256, SHA256, `${field}.buildLog.sha256`);
  positiveInteger(log.bytes, `${field}.buildLog.bytes`);
  const inspection = object(actual.inspection, `${field}.inspection`);
  string(inspection.path, `${field}.inspection.path`);
  match(inspection.sha256, SHA256, `${field}.inspection.sha256`);
  positiveInteger(inspection.bytes, `${field}.inspection.bytes`);
  exact(inspection.command, 'scripts/inspect-exact-artifact.mjs', `${field}.inspection.command`);
  return actual;
}

function validateInspectionFile(artifact, platform) {
  const inspection = JSON.parse(readFileSync(artifact.inspection.path, 'utf8'));
  exact(artifact.inspection.bytes, statSync(artifact.inspection.path).size, `artifacts.${platform}.inspection.bytes`);
  exact(artifact.inspection.sha256, sha256File(artifact.inspection.path), `artifacts.${platform}.inspection.sha256`);
  exact(inspection.schemaVersion, 'maina.exact-artifact-inspection.v1', `artifacts.${platform}.inspection.schemaVersion`);
  exact(inspection.platform, platform, `artifacts.${platform}.inspection.platform`);
  const inspectedArtifact = object(inspection.artifact, `artifacts.${platform}.inspection.artifact`);
  exact(inspectedArtifact.path, artifact.path, `artifacts.${platform}.inspection.artifact.path`);
  exact(inspectedArtifact.sha256, artifact.sha256, `artifacts.${platform}.inspection.artifact.sha256`);
  exact(inspectedArtifact.bytes, artifact.bytes, `artifacts.${platform}.inspection.artifact.bytes`);
  if (platform === 'ios') {
    const inspectedSymbols = object(inspection.debugSymbols, 'artifacts.ios.inspection.debugSymbols');
    exact(inspectedSymbols.path, artifact.debugSymbols.path, 'artifacts.ios.inspection.debugSymbols.path');
    exact(inspectedSymbols.sha256, artifact.debugSymbols.sha256, 'artifacts.ios.inspection.debugSymbols.sha256');
    exact(inspectedSymbols.bytes, artifact.debugSymbols.bytes, 'artifacts.ios.inspection.debugSymbols.bytes');
    exact(artifact.debugSymbols.bytes, statSync(artifact.debugSymbols.path).size, 'artifacts.ios.debugSymbols.bytes');
    exact(artifact.debugSymbols.sha256, sha256File(artifact.debugSymbols.path), 'artifacts.ios.debugSymbols.sha256');
  }
  if (JSON.stringify(inspection.audit) !== JSON.stringify(artifact.audit)) {
    fail(`artifacts.${platform}.audit`, 'must equal the audit derived by scripts/inspect-exact-artifact.mjs');
  }
}

function androidAudit(actual, plan) {
  const audit = object(actual.audit, 'artifacts.android.audit');
  exact(audit.packageName, plan.identity.androidPackage, 'artifacts.android.audit.packageName');
  exact(audit.versionName, plan.release.version, 'artifacts.android.audit.versionName');
  exact(audit.versionCode, plan.release.androidVersionCode, 'artifacts.android.audit.versionCode');
  exact(audit.releaseSigned, true, 'artifacts.android.audit.releaseSigned');
  exact(audit.signerCertificateSha256, plan.artifactPolicy.android.signerCertificateSha256, 'artifacts.android.audit.signerCertificateSha256');
  exact(audit.debuggable, false, 'artifacts.android.audit.debuggable');
  exact(audit.profileable, false, 'artifacts.android.audit.profileable');
  exact(audit.permissionsExact, true, 'artifacts.android.audit.permissionsExact');
  exact(audit.componentsExact, true, 'artifacts.android.audit.componentsExact');
  exact(audit.exportedBoundariesExact, true, 'artifacts.android.audit.exportedBoundariesExact');
  exactArray(audit.permissions, plan.artifactPolicy.android.permissions, 'artifacts.android.audit.permissions');
  exactJson(audit.components, plan.artifactPolicy.android.components, 'artifacts.android.audit.components');
  exactArray(audit.abis, [plan.toolchains.android.abi], 'artifacts.android.audit.abis');
  const jni = object(audit.jniLibraries, 'artifacts.android.audit.jniLibraries');
  for (const library of ['libonnxruntime.so', 'libsherpa-onnx-jni.so']) {
    match(jni[library], SHA256, `artifacts.android.audit.jniLibraries.${library}`);
  }
  exact(audit.vadModelSha256, 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20', 'artifacts.android.audit.vadModelSha256');
  const models = object(audit.modelChecksums, 'artifacts.android.audit.modelChecksums');
  if (Object.keys(models).length === 0) fail('artifacts.android.audit.modelChecksums', 'at least one exact model checksum is required');
  for (const [name, hash] of Object.entries(models)) match(hash, SHA256, `artifacts.android.audit.modelChecksums.${name}`);
  match(audit.contentsManifestSha256, SHA256, 'artifacts.android.audit.contentsManifestSha256');
}

function iosAudit(actual, plan) {
  const audit = object(actual.audit, 'artifacts.ios.audit');
  exact(audit.bundleIdentifier, plan.identity.iosBundleIdentifier, 'artifacts.ios.audit.bundleIdentifier');
  exact(audit.version, plan.release.version, 'artifacts.ios.audit.version');
  exact(audit.buildNumber, plan.release.iosBuildNumber, 'artifacts.ios.audit.buildNumber');
  exactArray(audit.architectures, ['arm64'], 'artifacts.ios.audit.architectures');
  exact(audit.signatureValid, true, 'artifacts.ios.audit.signatureValid');
  exact(audit.teamId, plan.identity.iosTeamId, 'artifacts.ios.audit.teamId');
  exact(audit.designatedRequirement, plan.artifactPolicy.ios.designatedRequirement, 'artifacts.ios.audit.designatedRequirement');
  exact(audit.entitlementsExact, true, 'artifacts.ios.audit.entitlementsExact');
  exactJson(audit.entitlements, plan.artifactPolicy.ios.appEntitlements, 'artifacts.ios.audit.entitlements');
  exactJson(audit.profileEntitlements, plan.artifactPolicy.ios.profileEntitlements, 'artifacts.ios.audit.profileEntitlements');
  match(audit.entitlementsSha256, SHA256, 'artifacts.ios.audit.entitlementsSha256');
  const profile = object(audit.profile, 'artifacts.ios.audit.profile');
  match(profile.uuid, UUID, 'artifacts.ios.audit.profile.uuid');
  exact(profile.name, plan.artifactPolicy.ios.profileName, 'artifacts.ios.audit.profile.name');
  exact(profile.teamId, plan.identity.iosTeamId, 'artifacts.ios.audit.profile.teamId');
  if (Number.isNaN(Date.parse(profile.expiresAt))) fail('artifacts.ios.audit.profile.expiresAt', 'ISO-8601 expiry is required');
  exact(profile.sufficientWindow, true, 'artifacts.ios.audit.profile.sufficientWindow');
  match(audit.appUuid, UUID, 'artifacts.ios.audit.appUuid');
  match(audit.dsymUuid, UUID, 'artifacts.ios.audit.dsymUuid');
  exact(audit.dsymUuid.toLowerCase(), audit.appUuid.toLowerCase(), 'artifacts.ios.audit.dsymUuid');
  match(audit.appContentsManifestSha256, SHA256, 'artifacts.ios.audit.appContentsManifestSha256');
  match(audit.appBundleSha256, SHA256, 'artifacts.ios.audit.appBundleSha256');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateReleaseProvenance(provenance, plan, options = {}) {
  const platform = options.platform ?? null;
  const requireBoth = options.requireBoth ?? false;
  const platforms = requireBoth ? ['android', 'ios'] : platform ? [platform] : ['android', 'ios'].filter((name) => provenance?.artifacts?.[name]);
  exact(provenance.schemaVersion, 'maina.release-provenance.v1', 'schemaVersion');
  exact(provenance.releaseId, plan.releaseId, 'releaseId');
  const release = object(provenance.release, 'release');
  exact(release.version, plan.release.version, 'release.version');
  exact(release.androidVersionCode, plan.release.androidVersionCode, 'release.androidVersionCode');
  exact(release.iosBuildNumber, plan.release.iosBuildNumber, 'release.iosBuildNumber');
  const sources = object(provenance.sources, 'sources');
  sourcePin(sources.android, plan.sources.android, 'sources.android');
  sourcePin(sources.ios, plan.sources.ios, 'sources.ios');
  exact(sources.coordinationCommit, plan.sources.coordinationCommit, 'sources.coordinationCommit');
  exact(sources.backendSourceCommit, plan.sources.backendSourceCommit, 'sources.backendSourceCommit');
  exact(sources.backendProductionDeployment, plan.sources.backendProductionDeployment, 'sources.backendProductionDeployment');
  featureFlags(provenance.featureFlagDefaults, plan.featureFlagDefaults);
  toolchains(provenance.toolchains, plan.toolchains, platforms);
  const artifacts = object(provenance.artifacts, 'artifacts');
  for (const name of platforms) {
    const artifact = commonArtifact(artifacts[name], `artifacts.${name}`);
    if (name === 'android') androidAudit(artifact, plan);
    else {
      const symbols = object(artifact.debugSymbols, 'artifacts.ios.debugSymbols');
      string(symbols.path, 'artifacts.ios.debugSymbols.path');
      match(symbols.sha256, SHA256, 'artifacts.ios.debugSymbols.sha256');
      positiveInteger(symbols.bytes, 'artifacts.ios.debugSymbols.bytes');
      match(symbols.uuid, UUID, 'artifacts.ios.debugSymbols.uuid');
      iosAudit(artifact, plan);
      exact(symbols.uuid.toLowerCase(), artifact.audit.dsymUuid.toLowerCase(), 'artifacts.ios.debugSymbols.uuid');
    }
  }
  if (requireBoth && (!artifacts.android || !artifacts.ios)) fail('artifacts', 'both exact platform artifacts are required');
  const approval = object(provenance.approval, 'approval');
  if (!['candidate', 'admin-approved'].includes(approval.status)) fail('approval.status', 'candidate or admin-approved is required');
  if (options.requireApproval) {
    exact(approval.status, 'admin-approved', 'approval.status');
    string(approval.approvedBy, 'approval.approvedBy');
    if (Number.isNaN(Date.parse(approval.approvedAt))) fail('approval.approvedAt', 'ISO-8601 approval time is required');
  }
  return true;
}

export function qualifyExactArtifact({ provenance, plan, platform, artifactPath, buildLogPath }) {
  if (!['android', 'ios'].includes(platform)) fail('platform', 'android or ios is required');
  validateReleaseProvenance(provenance, plan, { platform });
  const artifact = provenance.artifacts[platform];
  exact(artifact.path, artifactPath, `artifacts.${platform}.path`);
  exact(artifact.buildLog.path, buildLogPath, `artifacts.${platform}.buildLog.path`);
  exact(artifact.bytes, statSync(artifactPath).size, `artifacts.${platform}.bytes`);
  exact(artifact.sha256, sha256File(artifactPath), `artifacts.${platform}.sha256`);
  exact(artifact.buildLog.bytes, statSync(buildLogPath).size, `artifacts.${platform}.buildLog.bytes`);
  exact(artifact.buildLog.sha256, sha256File(buildLogPath), `artifacts.${platform}.buildLog.sha256`);
  validateInspectionFile(artifact, platform);
  return true;
}

export function validateApprovedRelease(provenance, plan) {
  validateReleaseProvenance(provenance, plan, { requireBoth: true, requireApproval: true });
  for (const platform of ['android', 'ios']) {
    const artifact = provenance.artifacts[platform];
    exact(artifact.bytes, statSync(artifact.path).size, `artifacts.${platform}.bytes`);
    exact(artifact.sha256, sha256File(artifact.path), `artifacts.${platform}.sha256`);
    exact(artifact.buildLog.bytes, statSync(artifact.buildLog.path).size, `artifacts.${platform}.buildLog.bytes`);
    exact(artifact.buildLog.sha256, sha256File(artifact.buildLog.path), `artifacts.${platform}.buildLog.sha256`);
    validateInspectionFile(artifact, platform);
  }
  return true;
}

export function authorizeExactArtifact({ provenance, plan, platform, artifactPath }) {
  if (!['android', 'ios'].includes(platform)) fail('platform', 'android or ios is required');
  validateApprovedRelease(provenance, plan);
  exact(provenance.artifacts[platform].path, artifactPath, `artifacts.${platform}.path`);
  const buildLogPath = provenance.artifacts[platform].buildLog.path;
  qualifyExactArtifact({ provenance, plan, platform, artifactPath, buildLogPath });
  return true;
}

export function replayConfig(provenance, plan) {
  validateApprovedRelease(provenance, plan);
  return {
    androidPackage: provenance.artifacts.android.audit.packageName,
    androidVersion: provenance.artifacts.android.audit.versionName,
    androidVersionCode: String(provenance.artifacts.android.audit.versionCode),
    iosBundleIdentifier: provenance.artifacts.ios.audit.bundleIdentifier,
    iosVersion: provenance.artifacts.ios.audit.version,
    iosBuildNumber: provenance.artifacts.ios.audit.buildNumber,
  };
}
