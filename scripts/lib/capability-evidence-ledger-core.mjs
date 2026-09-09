import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { validateJsonSchema } from '../../coordination/scripts/json-schema-validator.mjs';
import { parseJsonBytesRejectDuplicateKeys } from './strict-json.mjs';

export const PROOF_ORDER = Object.freeze([
  'VERIFIED_SOURCE',
  'VERIFIED_ARTIFACT',
  'VERIFIED_AUTOMATED_PHYSICAL',
  'VERIFIED_OWNER_PHYSICAL',
]);

export const OUTCOME_CLASSES = Object.freeze(['HARNESS_BLOCKED', 'FAILED', 'NOT_RUN']);
export const ALL_CLASSES = Object.freeze([...PROOF_ORDER, ...OUTCOME_CLASSES]);

const PROOF_RANK = new Map(PROOF_ORDER.map((value, index) => [value, index + 1]));
const FORBIDDEN_KEYS = new Set([
  'deviceid', 'devicename', 'meetingid', 'rawlog', 'rawoutput', 'serial', 'token', 'transcript', 'udid',
]);
const FORBIDDEN_STRING_PATTERNS = [
  /\/Users\//u,
  /\bBearer\s+/iu,
  /maina:\/\/\/meeting\//iu,
];
const EXTERNAL_EVIDENCE_ROOT = '/Volumes/DivaySSD/MainaBuild/artifacts/apps';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function canonicalDigest(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function frozenLedgerSections(ledger) {
  return {
    identity: {
      schemaVersion: ledger.schemaVersion,
      schemaSha256: ledger.schemaSha256,
      ledgerId: ledger.ledgerId,
      capturedAt: ledger.capturedAt,
      harness: ledger.harness,
      evidenceModel: ledger.evidenceModel,
    },
    baselines: ledger.baselines,
    candidate: ledger.candidate,
    claims: ledger.claims,
    evidence: ledger.evidence,
  };
}

export function expectedSummary(ledger) {
  const classCounts = Object.fromEntries(ALL_CLASSES.map((name) => [name, 0]));
  const satisfiedClaimIds = [];
  const unsatisfiedClaimIds = [];
  const releaseBlockingClaimIds = [];
  for (const claim of ledger.claims) {
    classCounts[claim.observedClass] += 1;
    (claim.satisfiesRequirement ? satisfiedClaimIds : unsatisfiedClaimIds).push(claim.id);
    if (claim.releaseBlocking && !claim.satisfiesRequirement) releaseBlockingClaimIds.push(claim.id);
  }
  return {
    releaseReady: releaseBlockingClaimIds.length === 0,
    classCounts,
    satisfiedClaimIds: satisfiedClaimIds.sort(compareCodeUnits),
    unsatisfiedClaimIds: unsatisfiedClaimIds.sort(compareCodeUnits),
    releaseBlockingClaimIds: releaseBlockingClaimIds.sort(compareCodeUnits),
    sourceAheadOfArtifactPlatforms: ['android', 'ios'],
    nextActionCode: 'RUN_CURRENT_CANDIDATE_OWNER_PHYSICAL_TEST3_THEN_FORMAL_TEST5',
  };
}

export function validateCapabilityEvidenceLedger(ledger, { schemaPath, rootDir, expectedSectionDigests }) {
  validateJsonSchema(ledger, schemaPath, rootDir, 'capability evidence ledger');
  assertStrictUtcTimestamp(ledger.capturedAt);
  assertExactKeys(
    expectedSectionDigests,
    ['identity', 'baselines', 'candidate', 'claims', 'evidence'],
    'expected section digests',
  );
  for (const [section, value] of Object.entries(frozenLedgerSections(ledger))) {
    assert(canonicalDigest(value) === expectedSectionDigests[section], `${section} frozen digest mismatch`);
  }
  assert(sha256File(schemaPath) === ledger.schemaSha256, 'schema SHA-256 mismatch');
  assertDeepEqual(ledger.evidenceModel.proofOrder, PROOF_ORDER, 'proof order drift');
  assertDeepEqual(ledger.evidenceModel.outcomeClasses, OUTCOME_CLASSES, 'outcome class drift');
  assert(ledger.harness.appRelease === ledger.candidate.version, 'harness/app release mismatch');
  assert(ledger.harness.deviceCommandsExecuted === 0, 'ledger generation must execute zero device commands');
  rejectPrivateLedgerMaterial(ledger);
  const planPath = join(rootDir, ledger.candidate.releasePlan.path);
  const planBytes = readFileSync(planPath);
  assert(
    sha256Bytes(planBytes) === ledger.candidate.releasePlan.sha256,
    'release plan SHA-256 mismatch',
  );
  assert(
    sha256File(join(rootDir, ledger.candidate.provenanceSchema.path)) === ledger.candidate.provenanceSchema.sha256,
    'provenance schema SHA-256 mismatch',
  );
  validateCandidateAgainstPlan(
    ledger.candidate,
    parseJsonBytesRejectDuplicateKeys(planBytes, 'release plan'),
  );

  assertSortedUnique(ledger.baselines, (item) => item.component, 'baselines');
  const baselineByComponent = new Map(ledger.baselines.map((item) => [item.component, item]));
  assert(baselineByComponent.size === 5, 'exactly five component baselines are required');
  for (const baseline of ledger.baselines) {
    assert(
      baseline.inputRevision === baseline.inputUpstreamRevision,
      `${baseline.component} baseline must be upstream-exact`,
    );
    const isApps = baseline.component === 'apps_android' || baseline.component === 'apps_ios';
    if (isApps) {
      assert(baseline.artifactSourceRevision !== null, `${baseline.component} artifact source is required`);
      assert(baseline.sourceAheadOfArtifact === true, `${baseline.component} source-ahead truth is required`);
      assert(
        baseline.artifactSourceRevision !== baseline.inputRevision,
        `${baseline.component} current source must remain distinct from artifact source`,
      );
    } else {
      assert(baseline.artifactSourceRevision === null, `${baseline.component} artifact source must be null`);
      assert(baseline.sourceAheadOfArtifact === null, `${baseline.component} source-ahead truth must be null`);
    }
  }
  for (const [platform, component] of [['android', 'apps_android'], ['ios', 'apps_ios']]) {
    const custody = ledger.candidate.sourceCustody[platform];
    const baseline = baselineByComponent.get(component);
    assert(custody.artifactSourceCommit === baseline.artifactSourceRevision, `${platform} artifact-source binding mismatch`);
    assert(custody.currentSourceBaseline === baseline.inputRevision, `${platform} current-source binding mismatch`);
    assert(custody.productCommit !== custody.artifactSourceCommit, `${platform} product and artifact-source commits must be distinct`);
  }

  assertSortedUnique(ledger.evidence, (item) => item.id, 'evidence');
  const evidenceById = new Map(ledger.evidence.map((item) => [item.id, item]));
  for (const item of ledger.evidence) validateEvidenceRecord(item, baselineByComponent);
  const locatorIdentities = ledger.evidence.map((item) => canonicalDigest(item.locator));
  assert(new Set(locatorIdentities).size === locatorIdentities.length, 'evidence locators must be unique');
  assert(
    ledger.candidate.candidateProvenanceSha256 === evidenceById.get('provenance.candidate.0.10.66')?.locator?.sha256,
    'candidate provenance is not bound to evidence',
  );
  assert(
    ledger.candidate.approvedProvenanceSha256 === evidenceById.get('provenance.approved.0.10.66')?.locator?.sha256,
    'approved provenance is not bound to evidence',
  );

  assertSortedUnique(ledger.claims, (item) => item.id, 'claims');
  for (const claim of ledger.claims) validateClaim(claim, evidenceById, ledger.candidate.version);
  const referencedEvidence = new Set(ledger.claims.flatMap((claim) => claim.evidenceIds));
  assert(
    ledger.evidence.every((item) => referencedEvidence.has(item.id)),
    'every evidence record must be referenced by at least one claim',
  );

  assertDeepEqual(ledger.summary, expectedSummary(ledger), 'summary is not deterministic');
  return ledger;
}

export function verifyExternalFileRecord(locator, { allowedRoot = EXTERNAL_EVIDENCE_ROOT } = {}) {
  assert(locator.type === 'EXTERNAL_FILE', 'external verification requires an EXTERNAL_FILE locator');
  validateExternalPath(locator.path, allowedRoot);
  const resolvedRoot = realpathSync(allowedRoot);
  const resolvedPath = realpathSync(locator.path);
  assert(resolvedPath.startsWith(`${resolvedRoot}${sep}`), 'external evidence real path escapes the guarded root');
  let descriptor;
  try {
    descriptor = openSync(locator.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    assert(before.isFile(), 'external evidence must be a regular file');
    assert(before.size === BigInt(locator.bytes), `external evidence byte mismatch: ${locator.path}`);
    const mode = Number(before.mode & 0o777n).toString(8).padStart(4, '0');
    assert(mode === locator.mode, `external evidence mode mismatch: ${locator.path}`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs']) {
      assert(before[key] === after[key], `external evidence changed while reading: ${locator.path}`);
    }
    const digest = sha256Bytes(bytes);
    assert(digest === locator.sha256, `external evidence SHA-256 mismatch: ${locator.path}`);
    return {
      content: bytes,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mode: before.mode,
      uid: before.uid,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
      sha256: digest,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function verifyAllExternalFiles(ledger) {
  const snapshots = new Map();
  for (const item of ledger.evidence) {
    if (item.locator.type === 'EXTERNAL_FILE') {
      const snapshot = verifyExternalFileRecord(item.locator);
      snapshots.set(item.locator.path, snapshot);
      if (item.privacyClass === 'RESTRICTED_EXTERNAL') {
        assert(item.locator.mode === '0600', `${item.id} restricted evidence must be mode 0600`);
        assert(snapshot.uid === BigInt(process.getuid()), `${item.id} restricted evidence owner mismatch`);
      }
      verifyEvidencePrivacyContent(item, snapshot.content);
    }
  }
  return snapshots;
}

export function verifyLocalGitBaselines(ledger, repositoryPaths) {
  const baselineByComponent = new Map(ledger.baselines.map((item) => [item.component, item]));
  for (const baseline of ledger.baselines) {
    const repositoryPath = repositoryPaths[baseline.component];
    assert(repositoryPath, `missing local repository path for ${baseline.component}`);
    const remote = git(repositoryPath, ['remote', 'get-url', 'origin']);
    assert(normalizeRemote(remote) === normalizeRemote(baseline.repository), `${baseline.component} remote mismatch`);
    assert(git(repositoryPath, ['branch', '--show-current']) === baseline.branch, `${baseline.component} current branch mismatch`);
    assert(
      git(repositoryPath, ['rev-parse', 'HEAD']) === git(repositoryPath, ['rev-parse', `origin/${baseline.branch}`]),
      `${baseline.component} current HEAD is not exact to its declared origin branch`,
    );
    assert(git(repositoryPath, ['cat-file', '-t', baseline.inputRevision]) === 'commit', `${baseline.component} input commit is absent`);
    assertAncestor(repositoryPath, baseline.inputRevision, 'HEAD', `${baseline.component} input commit is not in HEAD ancestry`);
    assertAncestor(
      repositoryPath,
      baseline.inputUpstreamRevision,
      `origin/${baseline.branch}`,
      `${baseline.component} observed upstream is not in remote branch ancestry`,
    );
  }
  for (const [platform, component] of [['android', 'apps_android'], ['ios', 'apps_ios']]) {
    const repositoryPath = repositoryPaths[component];
    const custody = ledger.candidate.sourceCustody[platform];
    assertAncestor(repositoryPath, custody.productCommit, custody.artifactSourceCommit, `${platform} product is not an artifact-source ancestor`);
    assertAncestor(repositoryPath, custody.artifactSourceCommit, custody.currentSourceBaseline, `${platform} artifact source is not a current-source ancestor`);
  }
  const coordination = baselineByComponent.get('coordination');
  assert(
    git(repositoryPaths.coordination, ['cat-file', '-t', ledger.candidate.buildBindings.coordinationCommit]) === 'commit',
    'build-time coordination commit is absent',
  );
  const backend = baselineByComponent.get('backend');
  assert(
    git(repositoryPaths.backend, ['cat-file', '-t', ledger.candidate.buildBindings.backendSourceCommit]) === 'commit',
    'build-time backend source commit is absent',
  );
  assertAncestor(
    repositoryPaths.coordination,
    ledger.candidate.buildBindings.coordinationCommit,
    coordination.inputRevision,
    'build-time coordination is not in current coordination ancestry',
  );
  assertAncestor(
    repositoryPaths.backend,
    ledger.candidate.buildBindings.backendSourceCommit,
    backend.inputRevision,
    'build-time backend source is not in current backend ancestry',
  );
}

function validateEvidenceRecord(item, baselineByComponent) {
  if (item.kind === 'SOURCE_COMMIT') {
    assert(item.locator.type === 'GIT_COMMIT', `${item.id} source evidence requires a Git locator`);
    assert(item.maximumClass === 'VERIFIED_SOURCE', `${item.id} source evidence ceiling must be source`);
    assert(item.privacyClass === 'SANITIZED', `${item.id} source evidence must be sanitized`);
    const baseline = baselineByComponent.get(item.locator.component);
    assert(baseline, `${item.id} references an unknown component`);
    assert(baseline.inputRevision === item.locator.revision, `${item.id} does not bind its input baseline`);
    const expectedPlatform = {
      apps_android: 'android',
      apps_ios: 'ios',
      backend: 'backend',
      web: 'web',
      coordination: 'cross_platform',
    }[item.locator.component];
    assert(item.platform === expectedPlatform, `${item.id} source component/platform mismatch`);
  } else {
    assert(item.locator.type === 'EXTERNAL_FILE', `${item.id} non-source evidence requires an external file`);
    validateExternalPath(item.locator.path);
    if (item.privacyClass === 'RESTRICTED_EXTERNAL') {
      assert(item.locator.mode === '0600', `${item.id} restricted evidence must declare mode 0600`);
    }
  }

  if (item.maximumClass === 'NOT_RUN') {
    throw new Error(`${item.id} must not encode NOT_RUN as evidence`);
  }
  if (item.kind === 'FAILURE_REPORT') assert(item.maximumClass === 'FAILED', `${item.id} failure ceiling mismatch`);
  if (item.kind === 'HARNESS_DIAGNOSTIC') {
    assert(item.maximumClass === 'HARNESS_BLOCKED', `${item.id} harness ceiling mismatch`);
  }
  if (
    item.kind === 'ARTIFACT'
    || item.kind === 'ARTIFACT_INSPECTION'
    || item.kind === 'PROVENANCE'
    || item.kind === 'OWNER_AUTHORIZATION'
  ) {
    assert(item.maximumClass === 'VERIFIED_ARTIFACT', `${item.id} artifact evidence ceiling mismatch`);
  }
  if (item.kind === 'ARTIFACT') {
    assert(
      item.privacyClass === 'OPAQUE_BINARY'
        || item.privacyClass === 'LOCAL_PATH_METADATA'
        || item.privacyClass === 'PRIVATE_BUILD_METADATA',
      `${item.id} artifact privacy classification mismatch`,
    );
  }
  if (item.kind === 'ARTIFACT_INSPECTION') {
    assert(
      item.privacyClass === 'LOCAL_PATH_METADATA' || item.privacyClass === 'PRIVATE_BUILD_METADATA',
      `${item.id} inspection privacy classification mismatch`,
    );
  }
  if (item.kind === 'PROVENANCE') {
    assert(
      item.privacyClass === 'LOCAL_PATH_METADATA' || item.privacyClass === 'PRIVATE_BUILD_METADATA',
      `${item.id} provenance privacy classification mismatch`,
    );
  }
  if (item.kind === 'AUTOMATED_RESULT') {
    assert(item.maximumClass === 'VERIFIED_AUTOMATED_PHYSICAL', `${item.id} automated evidence ceiling mismatch`);
  }
  if (item.kind === 'OWNER_PHYSICAL_RESULT') {
    assert(item.maximumClass === 'VERIFIED_OWNER_PHYSICAL', `${item.id} owner evidence ceiling mismatch`);
  }
}

function validateClaim(claim, evidenceById, activeVersion) {
  assertSortedUnique(claim.evidenceIds, (value) => value, `${claim.id} evidenceIds`);
  const refs = claim.evidenceIds.map((id) => {
    const record = evidenceById.get(id);
    assert(record, `${claim.id} references missing evidence ${id}`);
    assert(
      record.platform === claim.platform || record.platform === 'cross_platform',
      `${claim.id} evidence platform mismatch`,
    );
    assert(record.candidate === claim.candidate, `${claim.id} evidence candidate mismatch`);
    return record;
  });

  const observedRank = PROOF_RANK.get(claim.observedClass);
  const requiredRank = PROOF_RANK.get(claim.requiredClass);
  if (observedRank !== undefined) {
    assert(refs.length > 0, `${claim.id} positive proof requires evidence`);
    for (const record of refs) {
      const ceiling = PROOF_RANK.get(record.maximumClass);
      assert(ceiling !== undefined && ceiling >= observedRank, `${claim.id} exceeds evidence ceiling ${record.id}`);
    }
    const allowedKinds = claim.observedClass === 'VERIFIED_SOURCE'
      ? new Set(['SOURCE_COMMIT'])
      : claim.observedClass === 'VERIFIED_ARTIFACT'
        ? new Set(['ARTIFACT', 'ARTIFACT_INSPECTION', 'PROVENANCE', 'OWNER_AUTHORIZATION'])
        : claim.observedClass === 'VERIFIED_AUTOMATED_PHYSICAL'
          ? new Set(['AUTOMATED_RESULT'])
          : new Set(['OWNER_PHYSICAL_RESULT']);
    assert(refs.every((record) => allowedKinds.has(record.kind)), `${claim.id} uses evidence from the wrong proof domain`);
  } else if (claim.observedClass === 'NOT_RUN') {
    assert(refs.length === 0, `${claim.id} NOT_RUN cannot cite positive evidence`);
  } else {
    assert(refs.length > 0, `${claim.id} ${claim.observedClass} requires diagnostic evidence`);
    assert(
      refs.some((record) => record.maximumClass === claim.observedClass),
      `${claim.id} lacks matching ${claim.observedClass} evidence`,
    );
    const requiredKind = claim.observedClass === 'FAILED' ? 'FAILURE_REPORT' : 'HARNESS_DIAGNOSTIC';
    assert(refs.every((record) => record.kind === requiredKind), `${claim.id} uses the wrong diagnostic evidence kind`);
  }

  const expectedSatisfaction = observedRank !== undefined && observedRank >= requiredRank;
  assert(claim.satisfiesRequirement === expectedSatisfaction, `${claim.id} satisfaction is inflated or stale`);
  if (claim.releaseBlocking) {
    assert(claim.candidate === activeVersion, `${claim.id} release blocker must target the active candidate`);
    assert(
      claim.requiredClass === 'VERIFIED_OWNER_PHYSICAL',
      `${claim.id} release blocker must be an irreducible owner-physical claim`,
    );
  }
}

function validateExternalPath(path, allowedRoot = EXTERNAL_EVIDENCE_ROOT) {
  assert(isAbsolute(path), 'external evidence path must be absolute');
  assert(normalize(path) === path, 'external evidence path must already be normalized');
  assert(!path.split(sep).some((part) => part === '.' || part === '..'), 'external evidence path contains traversal');
  assert(
    path.startsWith(`${allowedRoot}${sep}`),
    'external evidence path escapes the guarded evidence root',
  );
}

function validateCandidateAgainstPlan(candidate, plan) {
  assert(candidate.releaseId === plan.releaseId, 'candidate release ID differs from release plan');
  assert(candidate.version === plan.release.version, 'candidate version differs from release plan');
  assert(candidate.androidVersionCode === plan.release.androidVersionCode, 'candidate Android code differs from release plan');
  assert(candidate.iosBuildNumber === plan.release.iosBuildNumber, 'candidate iOS build differs from release plan');
  assert(candidate.sourceCustody.android.productCommit === plan.sources.android.productCommit, 'Android product commit differs from release plan');
  assert(candidate.sourceCustody.ios.productCommit === plan.sources.ios.productCommit, 'iOS product commit differs from release plan');
  assert(candidate.buildBindings.coordinationCommit === plan.sources.coordinationCommit, 'coordination build binding differs from release plan');
  assert(candidate.buildBindings.backendSourceCommit === plan.sources.backendSourceCommit, 'backend build binding differs from release plan');
  assert(
    candidate.buildBindings.backendProductionDeployment === plan.sources.backendProductionDeployment,
    'backend deployment binding differs from release plan',
  );
  assert(plan.featureFlagDefaults.mobileMeetingTagsV1 === false, 'meeting tags must remain default-off');
  assert(plan.featureFlagDefaults.mobileMemoryPulseV1 === false, 'Pulse must remain default-off');
  assert(plan.featureFlagDefaults.mobileSavedRecallsV1 === false, 'Recall must remain default-off');
  assert(plan.featureFlagDefaults.pulseBackgroundPolling === false, 'Pulse background polling must remain off');
  assert(plan.featureFlagDefaults.smartRecallAutomaticExecution === false, 'Smart Recall automatic execution must remain off');
  assert(plan.featureFlagDefaults.pulseRefreshMode === 'manual-only', 'Pulse must remain manual-only');
  assert(plan.featureFlagDefaults.smartRecallExecutionMode === 'manual-only', 'Smart Recall must remain manual-only');
}

function assertStrictUtcTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value);
  assert(match, 'capturedAt must be an exact UTC second timestamp');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  assert(month >= 1 && month <= 12, 'capturedAt month is invalid');
  assert(day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate(), 'capturedAt day is invalid');
  assert(Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59, 'capturedAt time is invalid');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assertDeepEqual(Object.keys(value).sort(compareCodeUnits), [...keys].sort(compareCodeUnits), `${label} keys mismatch`);
}

function rejectPrivateLedgerMaterial(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateLedgerMaterial(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert(!FORBIDDEN_KEYS.has(key.toLowerCase()), `${path}.${key} uses a private key`);
      rejectPrivateLedgerMaterial(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_STRING_PATTERNS) assert(!pattern.test(value), `${path} contains private material`);
  }
}

export function verifyEvidencePrivacyContent(item, bytes) {
  if (item.privacyClass === 'OPAQUE_BINARY' || item.privacyClass === 'PRIVATE_BUILD_METADATA' || item.privacyClass === 'RESTRICTED_EXTERNAL') return;
  let source;
  try {
    source = UTF8.decode(bytes);
  } catch {
    throw new Error(`${item.id} ${item.privacyClass} evidence must be valid UTF-8 text`);
  }
  const identityPatterns = [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu];
  const patterns = item.privacyClass === 'SANITIZED'
    ? [/\/Users\//u, /\bBearer\s+/iu, /maina:\/\/\/meeting\//iu, ...identityPatterns]
    : identityPatterns;
  for (const pattern of patterns) {
    assert(!pattern.test(source), `${item.id} ${item.privacyClass} evidence contains private material`);
  }
}

function assertSortedUnique(items, identity, label) {
  const actual = items.map(identity);
  const expected = [...new Set(actual)].sort(compareCodeUnits);
  assertDeepEqual(actual, expected, `${label} must be unique and code-unit sorted`);
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(repositoryPath, args) {
  try {
    return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(`git verification failed for ${repositoryPath}`);
  }
}

function assertAncestor(repositoryPath, ancestor, descendant, message) {
  try {
    execFileSync('git', ['-C', repositoryPath, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new Error(message);
  }
}

function normalizeRemote(value) {
  return value.replace(/\.git$/u, '');
}

function assertDeepEqual(actual, expected, message) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
