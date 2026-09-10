import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseJsonBytesRejectDuplicateKeys } from './strict-json.mjs';

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
export const OWNER_RELEASE_AUTHORIZATION_SCOPE = Object.freeze([
  'release-provenance:approve',
  'preserving-data-install:android',
  'preserving-data-install:ios',
  'automated-device-qualification:android',
  'automated-device-qualification:ios',
]);

function fail(field, message) {
  throw new Error(`${field}: ${message}`);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'object is required');
  return value;
}

function exactKeys(value, expected, field) {
  value = object(value, field);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(field, `contains missing or unknown fields; expected ${JSON.stringify(wanted)}, found ${JSON.stringify(actual)}`);
  }
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

function snapshot(pathValue, options, field) {
  if (options.fileSnapshots === undefined) return null;
  if (!(options.fileSnapshots instanceof Map)) fail(field, 'fileSnapshots must be a Map');
  const value = options.fileSnapshots.get(pathValue);
  if (!value) fail(field, 'verified file snapshot is required');
  return value;
}

function fileBytes(pathValue, options, field) {
  const verified = snapshot(pathValue, options, field);
  if (verified) {
    if (!Buffer.isBuffer(verified.content)) fail(field, 'verified file content is required');
    return verified.content;
  }
  return readFileSync(pathValue);
}

function fileSize(pathValue, options, field) {
  const verified = snapshot(pathValue, options, field);
  return verified ? Number(verified.size) : statSync(pathValue).size;
}

function fileMode(pathValue, options, field) {
  const verified = snapshot(pathValue, options, field);
  return verified ? Number(verified.mode & 0o777n) : lstatSync(pathValue).mode & 0o777;
}

function fileSha256(pathValue, options, field) {
  const verified = snapshot(pathValue, options, field);
  return verified ? verified.sha256 : sha256File(pathValue);
}

function fileJson(pathValue, options, field) {
  return parseJsonBytesRejectDuplicateKeys(fileBytes(pathValue, options, field), field);
}

function sourcePin(actual, planned, field) {
  actual = exactKeys(actual, ['repository', 'branch', 'productCommit', 'finalCommit', 'upstreamCommit'], field);
  exact(actual.repository, planned.repository, `${field}.repository`);
  exact(actual.branch, planned.branch, `${field}.branch`);
  exact(actual.productCommit, planned.productCommit, `${field}.productCommit`);
  match(actual.finalCommit, GIT_SHA, `${field}.finalCommit`);
  match(actual.upstreamCommit, GIT_SHA, `${field}.upstreamCommit`);
  exact(actual.finalCommit, actual.upstreamCommit, `${field}.finalCommit`);
}

function featureFlags(actual, planned) {
  actual = exactKeys(actual, Object.keys(planned), 'featureFlagDefaults');
  for (const [name, expected] of Object.entries(planned)) {
    exact(actual[name], expected, `featureFlagDefaults.${name}`);
  }
}

function toolchains(actual, planned) {
  actual = exactKeys(actual, ['node', 'expo', 'reactNative', 'android', 'ios'], 'toolchains');
  if (planned.node) exact(actual.node, `v${planned.node}`, 'toolchains.node');
  else match(actual.node, /^v24\.[0-9]+\.[0-9]+$/, 'toolchains.node');
  exact(actual.expo, planned.expo.replace(/^~/, ''), 'toolchains.expo');
  exact(actual.reactNative, planned.reactNative, 'toolchains.reactNative');
  const android = exactKeys(actual.android, ['jdk', 'gradle', 'buildTools', 'compileSdk', 'targetSdk'], 'toolchains.android');
  match(android.jdk, /^17(?:\.|$)/, 'toolchains.android.jdk');
  exact(android.gradle, planned.android.gradle, 'toolchains.android.gradle');
  match(android.buildTools, /^[0-9]+(?:\.[0-9]+){2}$/, 'toolchains.android.buildTools');
  exact(android.compileSdk, planned.android.compileSdk, 'toolchains.android.compileSdk');
  exact(android.targetSdk, planned.android.targetSdk, 'toolchains.android.targetSdk');
  const ios = exactKeys(actual.ios, ['xcode', 'cocoaPods', 'swift'], 'toolchains.ios');
  string(ios.xcode, 'toolchains.ios.xcode');
  exact(ios.cocoaPods, planned.ios.cocoaPods, 'toolchains.ios.cocoaPods');
  string(ios.swift, 'toolchains.ios.swift');
}

function commonArtifact(actual, field, platform) {
  actual = exactKeys(actual, [
    'path', 'sha256', 'bytes', 'buildLog', 'inspection', 'audit',
    ...(platform === 'ios' ? ['debugSymbols'] : []),
  ], field);
  string(actual.path, `${field}.path`);
  match(actual.sha256, SHA256, `${field}.sha256`);
  positiveInteger(actual.bytes, `${field}.bytes`);
  const log = exactKeys(actual.buildLog, ['path', 'sha256', 'bytes'], `${field}.buildLog`);
  string(log.path, `${field}.buildLog.path`);
  match(log.sha256, SHA256, `${field}.buildLog.sha256`);
  positiveInteger(log.bytes, `${field}.buildLog.bytes`);
  const inspection = exactKeys(actual.inspection, ['path', 'sha256', 'bytes', 'command'], `${field}.inspection`);
  string(inspection.path, `${field}.inspection.path`);
  match(inspection.sha256, SHA256, `${field}.inspection.sha256`);
  positiveInteger(inspection.bytes, `${field}.inspection.bytes`);
  exact(inspection.command, 'scripts/inspect-exact-artifact.mjs', `${field}.inspection.command`);
  return actual;
}

function validateInspectionFile(artifact, platform, options = {}) {
  const inspection = fileJson(artifact.inspection.path, options, `artifacts.${platform}.inspection.file`);
  exactKeys(inspection, ['schemaVersion', 'platform', 'artifact', 'audit', ...(platform === 'ios' ? ['debugSymbols'] : [])], `artifacts.${platform}.inspection.file`);
  exact(artifact.inspection.bytes, fileSize(artifact.inspection.path, options, `artifacts.${platform}.inspection.bytes`), `artifacts.${platform}.inspection.bytes`);
  exact(artifact.inspection.sha256, fileSha256(artifact.inspection.path, options, `artifacts.${platform}.inspection.sha256`), `artifacts.${platform}.inspection.sha256`);
  exact(inspection.schemaVersion, 'maina.exact-artifact-inspection.v1', `artifacts.${platform}.inspection.schemaVersion`);
  exact(inspection.platform, platform, `artifacts.${platform}.inspection.platform`);
  const inspectedArtifact = exactKeys(inspection.artifact, ['path', 'sha256', 'bytes'], `artifacts.${platform}.inspection.artifact`);
  exact(inspectedArtifact.path, artifact.path, `artifacts.${platform}.inspection.artifact.path`);
  exact(inspectedArtifact.sha256, artifact.sha256, `artifacts.${platform}.inspection.artifact.sha256`);
  exact(inspectedArtifact.bytes, artifact.bytes, `artifacts.${platform}.inspection.artifact.bytes`);
  if (platform === 'ios') {
    const inspectedSymbols = exactKeys(inspection.debugSymbols, ['path', 'sha256', 'bytes'], 'artifacts.ios.inspection.debugSymbols');
    exact(inspectedSymbols.path, artifact.debugSymbols.path, 'artifacts.ios.inspection.debugSymbols.path');
    exact(inspectedSymbols.sha256, artifact.debugSymbols.sha256, 'artifacts.ios.inspection.debugSymbols.sha256');
    exact(inspectedSymbols.bytes, artifact.debugSymbols.bytes, 'artifacts.ios.inspection.debugSymbols.bytes');
    exact(artifact.debugSymbols.bytes, fileSize(artifact.debugSymbols.path, options, 'artifacts.ios.debugSymbols.bytes'), 'artifacts.ios.debugSymbols.bytes');
    exact(artifact.debugSymbols.sha256, fileSha256(artifact.debugSymbols.path, options, 'artifacts.ios.debugSymbols.sha256'), 'artifacts.ios.debugSymbols.sha256');
  }
  if (JSON.stringify(inspection.audit) !== JSON.stringify(artifact.audit)) {
    fail(`artifacts.${platform}.audit`, 'must equal the audit derived by scripts/inspect-exact-artifact.mjs');
  }
}

function androidAudit(actual, plan) {
  const audit = exactKeys(actual.audit, [
    'packageName', 'versionName', 'versionCode', 'releaseSigned', 'signerCertificateSha256',
    'debuggable', 'profileable', 'permissionsExact', 'componentsExact', 'exportedBoundariesExact',
    'permissions', 'components', 'abis', 'jniLibraries', 'vadModelSha256', 'modelChecksums',
    'contentsManifestSha256', 'inspectionTools',
  ], 'artifacts.android.audit');
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
  const jni = exactKeys(audit.jniLibraries, ['libonnxruntime.so', 'libsherpa-onnx-jni.so'], 'artifacts.android.audit.jniLibraries');
  for (const library of ['libonnxruntime.so', 'libsherpa-onnx-jni.so']) {
    match(jni[library], SHA256, `artifacts.android.audit.jniLibraries.${library}`);
  }
  exact(audit.vadModelSha256, 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20', 'artifacts.android.audit.vadModelSha256');
  const models = exactKeys(audit.modelChecksums, ['assets/silero_vad.int8.onnx'], 'artifacts.android.audit.modelChecksums');
  for (const [name, hash] of Object.entries(models)) match(hash, SHA256, `artifacts.android.audit.modelChecksums.${name}`);
  match(audit.contentsManifestSha256, SHA256, 'artifacts.android.audit.contentsManifestSha256');
  const inspectionTools = exactKeys(audit.inspectionTools, ['aapt2', 'apksigner', 'unzip'], 'artifacts.android.audit.inspectionTools');
  for (const [name, version] of Object.entries(inspectionTools)) string(version, `artifacts.android.audit.inspectionTools.${name}`);
}

function iosAudit(actual, plan) {
  const audit = exactKeys(actual.audit, [
    'bundleIdentifier', 'version', 'buildNumber', 'architectures', 'signatureValid', 'teamId',
    'designatedRequirement', 'entitlementsExact', 'entitlementsSha256', 'entitlements',
    'profileEntitlements', 'profile', 'appUuid', 'dsymUuid', 'appContentsManifestSha256',
    'appBundleSha256', 'inspectionTools',
  ], 'artifacts.ios.audit');
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
  const profile = exactKeys(audit.profile, ['uuid', 'name', 'teamId', 'expiresAt', 'sufficientWindow'], 'artifacts.ios.audit.profile');
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
  const inspectionTools = exactKeys(audit.inspectionTools, ['codesign', 'security', 'dwarfdump', 'ditto'], 'artifacts.ios.audit.inspectionTools');
  for (const [name, version] of Object.entries(inspectionTools)) string(version, `artifacts.ios.audit.inspectionTools.${name}`);
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function candidateSha256FromApproved(provenance) {
  const candidate = structuredClone(provenance);
  candidate.approval = { status: 'candidate', approvedBy: null, approvedAt: null };
  return sha256Text(`${JSON.stringify(candidate, null, 2)}\n`);
}

function validateOwnerAuthorization(provenance, planSha256, options = {}) {
  match(planSha256, SHA256, 'planSha256');
  const approval = provenance.approval;
  const reference = exactKeys(approval.authorization, [
    'path', 'sha256', 'bytes', 'authorizationId', 'directiveSha256', 'planSha256',
    'candidateProvenanceSha256', 'androidArtifactSha256', 'iosArtifactSha256',
    'scope', 'nonce', 'issuedAt',
  ], 'approval.authorization');
  string(reference.path, 'approval.authorization.path');
  if (!path.isAbsolute(reference.path)) fail('approval.authorization.path', 'absolute path is required');
  match(reference.sha256, SHA256, 'approval.authorization.sha256');
  positiveInteger(reference.bytes, 'approval.authorization.bytes');
  if (options.fileSnapshots === undefined) {
    const authorizationStat = lstatSync(reference.path);
    if (!authorizationStat.isFile() || authorizationStat.isSymbolicLink()) fail('approval.authorization.path', 'regular non-symlink file is required');
  }
  exact(fileMode(reference.path, options, 'approval.authorization.mode'), 0o600, 'approval.authorization.mode');
  exact(reference.bytes, fileSize(reference.path, options, 'approval.authorization.bytes'), 'approval.authorization.bytes');
  exact(reference.sha256, fileSha256(reference.path, options, 'approval.authorization.sha256'), 'approval.authorization.sha256');

  const envelope = exactKeys(fileJson(reference.path, options, 'ownerAuthorization'), [
    'schemaVersion', 'authorizationId', 'authorizedBy', 'sourceThreadId', 'directive',
    'directiveSha256', 'releaseId', 'planSha256', 'candidateProvenanceSha256',
    'artifactSha256', 'scope', 'issuedAt', 'nonce',
  ], 'ownerAuthorization');
  exact(envelope.schemaVersion, 'maina.owner-release-authorization.v1', 'ownerAuthorization.schemaVersion');
  string(envelope.authorizationId, 'ownerAuthorization.authorizationId');
  if (envelope.authorizationId.length > 128) fail('ownerAuthorization.authorizationId', 'must be at most 128 characters');
  exact(envelope.authorizedBy, 'owner-direct', 'ownerAuthorization.authorizedBy');
  match(envelope.sourceThreadId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'ownerAuthorization.sourceThreadId');
  string(envelope.directive, 'ownerAuthorization.directive');
  if (envelope.directive.length > 4096) fail('ownerAuthorization.directive', 'must be at most 4096 characters');
  match(envelope.directiveSha256, SHA256, 'ownerAuthorization.directiveSha256');
  exact(envelope.directiveSha256, sha256Text(envelope.directive), 'ownerAuthorization.directiveSha256');
  exact(envelope.releaseId, provenance.releaseId, 'ownerAuthorization.releaseId');
  exact(envelope.planSha256, planSha256, 'ownerAuthorization.planSha256');
  exact(envelope.candidateProvenanceSha256, candidateSha256FromApproved(provenance), 'ownerAuthorization.candidateProvenanceSha256');
  const artifactSha256 = exactKeys(envelope.artifactSha256, ['android', 'ios'], 'ownerAuthorization.artifactSha256');
  exact(artifactSha256.android, provenance.artifacts.android.sha256, 'ownerAuthorization.artifactSha256.android');
  exact(artifactSha256.ios, provenance.artifacts.ios.sha256, 'ownerAuthorization.artifactSha256.ios');
  exactArray(envelope.scope, OWNER_RELEASE_AUTHORIZATION_SCOPE, 'ownerAuthorization.scope');
  if (Number.isNaN(Date.parse(envelope.issuedAt))) fail('ownerAuthorization.issuedAt', 'ISO-8601 time is required');
  match(envelope.nonce, UUID, 'ownerAuthorization.nonce');

  exact(reference.authorizationId, envelope.authorizationId, 'approval.authorization.authorizationId');
  exact(reference.directiveSha256, envelope.directiveSha256, 'approval.authorization.directiveSha256');
  exact(reference.planSha256, envelope.planSha256, 'approval.authorization.planSha256');
  exact(reference.candidateProvenanceSha256, envelope.candidateProvenanceSha256, 'approval.authorization.candidateProvenanceSha256');
  exact(reference.androidArtifactSha256, artifactSha256.android, 'approval.authorization.androidArtifactSha256');
  exact(reference.iosArtifactSha256, artifactSha256.ios, 'approval.authorization.iosArtifactSha256');
  exactArray(reference.scope, envelope.scope, 'approval.authorization.scope');
  exact(reference.nonce, envelope.nonce, 'approval.authorization.nonce');
  exact(reference.issuedAt, envelope.issuedAt, 'approval.authorization.issuedAt');
  exact(approval.approvedBy, envelope.authorizedBy, 'approval.approvedBy');
  exact(approval.approvedAt, envelope.issuedAt, 'approval.approvedAt');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateReleaseProvenance(provenance, plan, options = {}) {
  const platform = options.platform ?? null;
  const requireBoth = options.requireBoth ?? false;
  const platforms = requireBoth ? ['android', 'ios'] : platform ? [platform] : ['android', 'ios'].filter((name) => provenance?.artifacts?.[name]);
  provenance = exactKeys(provenance, ['schemaVersion', 'releaseId', 'release', 'sources', 'toolchains', 'featureFlagDefaults', 'artifacts', 'approval'], 'provenance');
  exact(provenance.schemaVersion, 'maina.release-provenance.v1', 'schemaVersion');
  exact(provenance.releaseId, plan.releaseId, 'releaseId');
  const release = exactKeys(provenance.release, ['version', 'androidVersionCode', 'iosBuildNumber'], 'release');
  exact(release.version, plan.release.version, 'release.version');
  exact(release.androidVersionCode, plan.release.androidVersionCode, 'release.androidVersionCode');
  exact(release.iosBuildNumber, plan.release.iosBuildNumber, 'release.iosBuildNumber');
  const sources = exactKeys(provenance.sources, ['android', 'ios', 'coordinationCommit', 'backendSourceCommit', 'backendProductionDeployment'], 'sources');
  sourcePin(sources.android, plan.sources.android, 'sources.android');
  sourcePin(sources.ios, plan.sources.ios, 'sources.ios');
  exact(sources.coordinationCommit, plan.sources.coordinationCommit, 'sources.coordinationCommit');
  exact(sources.backendSourceCommit, plan.sources.backendSourceCommit, 'sources.backendSourceCommit');
  exact(sources.backendProductionDeployment, plan.sources.backendProductionDeployment, 'sources.backendProductionDeployment');
  featureFlags(provenance.featureFlagDefaults, plan.featureFlagDefaults);
  toolchains(provenance.toolchains, plan.toolchains);
  const artifacts = exactKeys(provenance.artifacts, ['android', 'ios'], 'artifacts');
  for (const name of platforms) {
    const artifact = commonArtifact(artifacts[name], `artifacts.${name}`, name);
    if (name === 'android') androidAudit(artifact, plan);
    else {
      const symbols = exactKeys(artifact.debugSymbols, ['path', 'sha256', 'bytes', 'uuid'], 'artifacts.ios.debugSymbols');
      string(symbols.path, 'artifacts.ios.debugSymbols.path');
      match(symbols.sha256, SHA256, 'artifacts.ios.debugSymbols.sha256');
      positiveInteger(symbols.bytes, 'artifacts.ios.debugSymbols.bytes');
      match(symbols.uuid, UUID, 'artifacts.ios.debugSymbols.uuid');
      iosAudit(artifact, plan);
      exact(symbols.uuid.toLowerCase(), artifact.audit.dsymUuid.toLowerCase(), 'artifacts.ios.debugSymbols.uuid');
    }
  }
  if (requireBoth && (!artifacts.android || !artifacts.ios)) fail('artifacts', 'both exact platform artifacts are required');
  const approvalStatus = provenance.approval?.status;
  const approval = exactKeys(
    provenance.approval,
    approvalStatus === 'admin-approved' ? ['status', 'approvedBy', 'approvedAt', 'authorization'] : ['status', 'approvedBy', 'approvedAt'],
    'approval',
  );
  if (!['candidate', 'admin-approved'].includes(approval.status)) fail('approval.status', 'candidate or admin-approved is required');
  if (approval.status === 'candidate') {
    exact(approval.approvedBy, null, 'approval.approvedBy');
    exact(approval.approvedAt, null, 'approval.approvedAt');
  }
  if (options.requireApproval) {
    exact(approval.status, 'admin-approved', 'approval.status');
    string(approval.approvedBy, 'approval.approvedBy');
    if (Number.isNaN(Date.parse(approval.approvedAt))) fail('approval.approvedAt', 'ISO-8601 approval time is required');
    validateOwnerAuthorization(provenance, options.planSha256, options);
  }
  return true;
}

export function qualifyExactArtifact({ provenance, plan, platform, artifactPath, buildLogPath, planSha256, fileSnapshots }) {
  if (!['android', 'ios'].includes(platform)) fail('platform', 'android or ios is required');
  const options = { platform, planSha256, fileSnapshots };
  validateReleaseProvenance(provenance, plan, options);
  const artifact = provenance.artifacts[platform];
  exact(artifact.path, artifactPath, `artifacts.${platform}.path`);
  exact(artifact.buildLog.path, buildLogPath, `artifacts.${platform}.buildLog.path`);
  exact(artifact.bytes, fileSize(artifactPath, options, `artifacts.${platform}.bytes`), `artifacts.${platform}.bytes`);
  exact(artifact.sha256, fileSha256(artifactPath, options, `artifacts.${platform}.sha256`), `artifacts.${platform}.sha256`);
  exact(artifact.buildLog.bytes, fileSize(buildLogPath, options, `artifacts.${platform}.buildLog.bytes`), `artifacts.${platform}.buildLog.bytes`);
  exact(artifact.buildLog.sha256, fileSha256(buildLogPath, options, `artifacts.${platform}.buildLog.sha256`), `artifacts.${platform}.buildLog.sha256`);
  validateInspectionFile(artifact, platform, options);
  return true;
}

export function validateApprovedRelease(provenance, plan, options = {}) {
  const validationOptions = {
    requireBoth: true,
    requireApproval: true,
    planSha256: options.planSha256,
    fileSnapshots: options.fileSnapshots,
  };
  validateReleaseProvenance(provenance, plan, validationOptions);
  for (const platform of ['android', 'ios']) {
    const artifact = provenance.artifacts[platform];
    exact(artifact.bytes, fileSize(artifact.path, validationOptions, `artifacts.${platform}.bytes`), `artifacts.${platform}.bytes`);
    exact(artifact.sha256, fileSha256(artifact.path, validationOptions, `artifacts.${platform}.sha256`), `artifacts.${platform}.sha256`);
    exact(artifact.buildLog.bytes, fileSize(artifact.buildLog.path, validationOptions, `artifacts.${platform}.buildLog.bytes`), `artifacts.${platform}.buildLog.bytes`);
    exact(artifact.buildLog.sha256, fileSha256(artifact.buildLog.path, validationOptions, `artifacts.${platform}.buildLog.sha256`), `artifacts.${platform}.buildLog.sha256`);
    validateInspectionFile(artifact, platform, validationOptions);
  }
  return true;
}

export function authorizeExactArtifact({ provenance, plan, platform, artifactPath, planSha256 }) {
  if (!['android', 'ios'].includes(platform)) fail('platform', 'android or ios is required');
  validateApprovedRelease(provenance, plan, { planSha256 });
  exact(provenance.artifacts[platform].path, artifactPath, `artifacts.${platform}.path`);
  const buildLogPath = provenance.artifacts[platform].buildLog.path;
  qualifyExactArtifact({ provenance, plan, platform, artifactPath, buildLogPath });
  return true;
}

export function replayConfig(provenance, plan, options = {}) {
  validateApprovedRelease(provenance, plan, { planSha256: options.planSha256 });
  return {
    androidPackage: provenance.artifacts.android.audit.packageName,
    androidVersion: provenance.artifacts.android.audit.versionName,
    androidVersionCode: String(provenance.artifacts.android.audit.versionCode),
    iosBundleIdentifier: provenance.artifacts.ios.audit.bundleIdentifier,
    iosVersion: provenance.artifacts.ios.audit.version,
    iosBuildNumber: provenance.artifacts.ios.audit.buildNumber,
  };
}
