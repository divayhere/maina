#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { sha256File, validateApprovedRelease } from './lib/release-provenance-core.mjs';
import { parseJsonBytesRejectDuplicateKeys } from './lib/strict-json.mjs';
import {
  androidLifecycleScenarioPolicy,
  deriveQualificationEvidenceDigest,
  deriveQualificationRecordingRunId,
} from './qualification/android-lifecycle-scenario.mjs';

const INTERNAL_OUTPUT_ROOT = '/Users/divay/.cache/maina-build-v2/outputs';
const DEFAULT_LEDGER_ROOT = join(INTERNAL_OUTPUT_ROOT, 'android-lifecycle-attempt-ledger');
const CANONICAL_ADB = '/Users/divay/Library/Android/sdk/platform-tools/adb';
const CANONICAL_ADB_SHA256 = '1811e253b21b12cbfda7201ebaf86c10e7ddcb5c606a7a81f7c82b4c429c2d3b';
const CANONICAL_ADB_VERSION = '37.0.1-15733141';
const CANONICAL_GIT = '/usr/bin/git';
const CANONICAL_GIT_SHA256 = 'b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9';
const CANONICAL_GIT_VERSION = 'git version 2.50.1 (Apple Git-155)';
const SHA256 = /^[0-9a-f]{64}$/u;
const RESULT_KEYS = ['cleanup', 'measurements', 'mutations', 'reasonCode', 'reconciliationRequired', 'status', 'tests'];
const QUALIFICATION_RUNTIME_DELTA_PATHS = Object.freeze([
  'scripts/qualification/android-lifecycle-adapter.mjs',
  'scripts/run-android-lifecycle-qualification.mjs',
  'scripts/verify-android-lifecycle-adapter.mjs',
  'scripts/verify-android-lifecycle-evidence.mjs',
  'scripts/verify-android-lifecycle-runner.mjs',
]);
const ATTEMPT_KEYS = [
  'adb', 'artifact', 'attemptNonce', 'attemptRoot', 'executionMode', 'expectedBuild', 'expectedVersion', 'git',
  'ledger', 'node', 'physicalIncomingCallTestPerformed', 'plan', 'provenance', 'rawDeviceOutputPersisted',
  'releaseId', 'runtimeFiles', 'schemaVersion', 'serialSha256', 'source', 'startedAt', 'status',
];
const TERMINAL_KEYS = [
  'attemptSha256', 'completedAt', 'executionMode', 'mutationJournal', 'reasonCode',
  'reconciliationRequired', 'resultSha256', 'schemaVersion', 'status',
];
const MEASUREMENT_KEYS = [
  'afterIdleRestartCount', 'afterNormalSaveCount', 'afterRecoveryCount', 'backgroundNativeProgressAdvanced',
  'backgroundTimerAdvanceSeconds', 'beforeNormalSaveCount', 'beforeRecoveryCount', 'firstResumeAcceptedMs',
  'firstTimerSeconds', 'normalSaveNativeInactive', 'pausedNativeProgressHeld', 'pausedTimerAfterHoldSeconds',
  'pausedTimerSeconds', 'powerOffObserved', 'powerOnObserved', 'recoveredAudioAvailable',
  'recoveredPositiveSegments', 'recoveredRetranscribe', 'recoveredVisibleCardCount', 'recoveryCorrelation',
  'screenOffNativeProgressAdvanced', 'screenOffTimerAdvanceSeconds', 'secondTimerSeconds',
  'syntheticMeetingsRetained', 'timerAdvanceSeconds',
];
const RUNTIME_PATHS = [
  'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt',
  'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaHardwareTrigger.kt',
  'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaQualificationSessionAuthority.kt',
  'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt',
  'scripts/qualification/android-lifecycle-adapter.mjs',
  'scripts/qualification/android-lifecycle-core.mjs',
  'scripts/qualification/android-lifecycle-scenario.mjs',
  'scripts/run-android-lifecycle-qualification.mjs',
  'src/app/record.tsx',
  'src/core/recording/qualificationSession.ts',
  'src/data/meetings.ts',
  'src/hardware/recording/foreground.ts',
  'src/services/remoteLog.ts',
];

export class AndroidLifecycleEvidenceFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'AndroidLifecycleEvidenceFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new AndroidLifecycleEvidenceFailure(code);
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || !actual.every((key, index) => key === expected[index])) fail(code);
  return value;
}

function isFileSystemFailure(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string'
    && (typeof error.syscall === 'string' || error.code === 'ERR_ACCESS_DENIED');
}

export function exactFileWithIo(path, record, code, mode, io) {
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
    throw new TypeError('exactFile requires a bounded reason code');
  }
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
    throw new TypeError('exactFile requires a valid file mode');
  }
  if (typeof path !== 'string' || !isAbsolute(path)) fail(code);
  if (record !== null) {
    exactKeys(record, ['bytes', 'mode', 'path', 'sha256'], code);
    if (record.path !== path || !Number.isSafeInteger(record.bytes) || record.bytes < 0
      || record.mode !== mode || !SHA256.test(record.sha256)) fail(code);
  }
  let value;
  try {
    value = io.lstat(path);
  } catch (error) {
    if (isFileSystemFailure(error)) fail(code);
    throw error;
  }
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o777) !== mode
    || (record && record.bytes !== value.size)) fail(code);
  if (record) {
    let digest;
    try {
      digest = io.sha256(path);
    } catch (error) {
      if (isFileSystemFailure(error)) fail(code);
      throw error;
    }
    if (record.sha256 !== digest) fail(code);
  }
  return value;
}

export function exactFile(path, record, code, mode = 0o600) {
  return exactFileWithIo(path, record, code, mode, {
    lstat: lstatSync,
    sha256: sha256File,
  });
}

function json(path, code) {
  exactFile(path, null, code);
  try {
    return parseJsonBytesRejectDuplicateKeys(readFileSync(path), code);
  } catch {
    fail(code);
  }
}

function verifyLooseFileRecord(record, code, { pathKey = true } = {}) {
  const keys = pathKey ? ['bytes', 'mode', 'path', 'sha256'] : ['bytes', 'mode', 'relativePath', 'sha256'];
  exactKeys(record, keys, code);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0
    || !Number.isSafeInteger(record.mode) || record.mode < 0 || record.mode > 0o777
    || !SHA256.test(record.sha256)) fail(code);
}

function gitObject(repository, commit) {
  const result = spawnSync(CANONICAL_GIT, ['-C', repository, 'rev-parse', `${commit}^{commit}`], { encoding: 'utf8', timeout: 15_000 });
  return result.status === 0 && result.signal === null && result.stdout.trim() === commit;
}

function expectedQualificationDeltaPaths(expectedVersion) {
  if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(expectedVersion)) {
    fail('RELEASE_BINDING_INVALID');
  }
  return [
    `release/m3-m4-${expectedVersion}-candidate-plan.json`,
    ...QUALIFICATION_RUNTIME_DELTA_PATHS,
    `scripts/verify-release-plan-${expectedVersion}.mjs`,
  ].sort();
}

function validateGitContentRecord(record, code) {
  exactKeys(record, ['bytes', 'mode', 'sha256'], code);
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0
    || ![0o644, 0o755].includes(record.mode) || !SHA256.test(record.sha256)) fail(code);
  return record;
}

function verifyQualificationSource(source, expectedVersion, provenanceSource) {
  exactKeys(source, ['artifactCommit', 'postBuildDelta', 'qualificationCommit', 'repository'], 'ATTEMPT_BINDING_INVALID');
  const expectedPaths = expectedQualificationDeltaPaths(expectedVersion);
  if (!isAbsolute(source.repository)
    || !/^[0-9a-f]{40}$/u.test(source.artifactCommit)
    || !/^[0-9a-f]{40}$/u.test(source.qualificationCommit)
    || source.repository !== provenanceSource.repository
    || source.artifactCommit !== provenanceSource.finalCommit
    || !gitObject(source.repository, source.artifactCommit)
    || !gitObject(source.repository, source.qualificationCommit)
    || !Array.isArray(source.postBuildDelta)
    || source.postBuildDelta.length !== expectedPaths.length) fail('RELEASE_BINDING_INVALID');
  const ancestor = spawnSync(CANONICAL_GIT, [
    '-C', source.repository, 'merge-base', '--is-ancestor', source.artifactCommit, source.qualificationCommit,
  ], { encoding: 'utf8', timeout: 15_000 });
  if (ancestor.status !== 0 || ancestor.signal !== null || ancestor.stdout !== '' || ancestor.stderr !== '') {
    fail('RELEASE_BINDING_INVALID');
  }
  const diff = spawnSync(CANONICAL_GIT, [
    '-C', source.repository, 'diff', '--name-status', '--no-renames',
    source.artifactCommit, source.qualificationCommit, '--',
  ], { encoding: 'utf8', timeout: 15_000 });
  if (diff.status !== 0 || diff.signal !== null || diff.stderr !== '') fail('RELEASE_BINDING_INVALID');
  const actualLines = diff.stdout.trim() === '' ? [] : diff.stdout.trim().split('\n');
  const actualPaths = actualLines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 2 || fields[0] !== 'M') fail('RELEASE_BINDING_INVALID');
    return fields[1];
  }).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) fail('RELEASE_BINDING_INVALID');
  const recordedPaths = [];
  for (const entry of source.postBuildDelta) {
    exactKeys(entry, ['artifact', 'path', 'qualification', 'status'], 'ATTEMPT_BINDING_INVALID');
    validateGitContentRecord(entry.artifact, 'ATTEMPT_BINDING_INVALID');
    validateGitContentRecord(entry.qualification, 'ATTEMPT_BINDING_INVALID');
    if (entry.status !== 'M' || !expectedPaths.includes(entry.path)) fail('RELEASE_BINDING_INVALID');
    const artifact = gitFileRecord(source.repository, source.artifactCommit, entry.path, 'RELEASE_BINDING_INVALID');
    const qualification = gitFileRecord(source.repository, source.qualificationCommit, entry.path, 'RELEASE_BINDING_INVALID');
    if (JSON.stringify(entry.artifact) !== JSON.stringify(artifact)
      || JSON.stringify(entry.qualification) !== JSON.stringify(qualification)) fail('RELEASE_BINDING_INVALID');
    recordedPaths.push(entry.path);
  }
  if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)) fail('RELEASE_BINDING_INVALID');
}

function gitFileRecord(repository, commit, relativePath, code) {
  const blob = spawnSync(CANONICAL_GIT, ['-C', repository, 'show', `${commit}:${relativePath}`], {
    encoding: null,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const tree = spawnSync(CANONICAL_GIT, ['-C', repository, 'ls-tree', commit, '--', relativePath], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (blob.status !== 0 || blob.signal !== null || !Buffer.isBuffer(blob.stdout)
    || tree.status !== 0 || tree.signal !== null) fail(code);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t(.+)\n?$/u.exec(tree.stdout);
  if (!match || match[2] !== relativePath) fail(code);
  return Object.freeze({
    bytes: blob.stdout.length,
    mode: match[1] === '100755' ? 0o755 : 0o644,
    sha256: createHash('sha256').update(blob.stdout).digest('hex'),
  });
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateMeasurements(measurements, passed) {
  exactKeys(measurements, MEASUREMENT_KEYS, 'RESULT_MEASUREMENTS_INVALID');
  const nullableIntegers = [
    'afterIdleRestartCount', 'afterNormalSaveCount', 'afterRecoveryCount', 'backgroundTimerAdvanceSeconds',
    'beforeNormalSaveCount', 'beforeRecoveryCount', 'firstResumeAcceptedMs', 'firstTimerSeconds',
    'pausedTimerAfterHoldSeconds', 'pausedTimerSeconds', 'recoveredVisibleCardCount',
    'screenOffTimerAdvanceSeconds', 'secondTimerSeconds', 'timerAdvanceSeconds',
  ];
  const nullableUnitCounts = ['recoveredAudioAvailable', 'recoveredPositiveSegments', 'recoveredRetranscribe'];
  const booleans = [
    'backgroundNativeProgressAdvanced', 'normalSaveNativeInactive', 'pausedNativeProgressHeld',
    'powerOffObserved', 'powerOnObserved', 'screenOffNativeProgressAdvanced',
  ];
  if (nullableIntegers.some((key) => measurements[key] !== null && !nonnegativeInteger(measurements[key]))
    || nullableUnitCounts.some((key) => measurements[key] !== null && ![0, 1].includes(measurements[key]))
    || booleans.some((key) => typeof measurements[key] !== 'boolean')
    || !nonnegativeInteger(measurements.syntheticMeetingsRetained)
    || (measurements.recoveryCorrelation !== null
      && measurements.recoveryCorrelation !== 'newest_first_count_delta_plus_exact_row_identity')) {
    fail('RESULT_MEASUREMENTS_INVALID');
  }
  if (!passed) return;
  if (nullableIntegers.some((key) => measurements[key] === null)
    || nullableUnitCounts.some((key) => measurements[key] === null)
    || measurements.secondTimerSeconds - measurements.firstTimerSeconds !== measurements.timerAdvanceSeconds
    || measurements.timerAdvanceSeconds < 2
    || measurements.firstResumeAcceptedMs > androidLifecycleScenarioPolicy.maxFirstResumeAcceptedMs
    || measurements.pausedTimerAfterHoldSeconds !== measurements.pausedTimerSeconds
    || measurements.backgroundTimerAdvanceSeconds < 6
    || measurements.screenOffTimerAdvanceSeconds < 6
    || measurements.afterNormalSaveCount !== measurements.beforeNormalSaveCount + 1
    || measurements.afterIdleRestartCount !== measurements.afterNormalSaveCount
    || measurements.beforeRecoveryCount !== measurements.afterIdleRestartCount
    || measurements.afterRecoveryCount !== measurements.beforeRecoveryCount + 1
    || measurements.recoveredVisibleCardCount < 1
    || measurements.recoveryCorrelation !== 'newest_first_count_delta_plus_exact_row_identity'
    || measurements.recoveredAudioAvailable !== 1
    || measurements.recoveredPositiveSegments !== 1
    || !booleans.every((key) => measurements[key] === true)
    || measurements.syntheticMeetingsRetained !== 2) fail('RESULT_MEASUREMENTS_INVALID');
}

function passedMutationTraceIndex(entries) {
  return androidLifecycleScenarioPolicy.passedMutationTraces.findIndex((trace) => (
    trace.length === entries.length && trace.every(([id, action, payloadShape], index) => {
      const entry = entries[index];
      return entry.id === id && entry.action === action
        && (['arm_qualification', 'launch_record_qualification'].includes(action)
          ? typeof entry.payloadDigest === 'string' && /^[0-9a-f]{64}$/u.test(entry.payloadDigest)
          : entry.payloadDigest === null)
        && JSON.stringify(entry.payloadShape) === JSON.stringify(payloadShape)
        && entry.state === 'confirmed_applied' && entry.attempts === 1;
    })
      && entries.filter((entry) => entry.action === 'arm_qualification').every((entry) => (
        entries.find((candidate) => candidate.id === entry.id.replace(/-arm$/u, ''))?.payloadDigest === entry.payloadDigest
      ))
      && new Set(entries.filter((entry) => entry.action === 'arm_qualification').map((entry) => entry.payloadDigest)).size === 2
  ));
}

export function validatePassedAndroidLifecycleResult(result) {
  exactKeys(result, RESULT_KEYS, 'RESULT_INVALID');
  validateMeasurements(result.measurements, true);
  if (result.status !== 'passed' || result.reasonCode !== null || result.reconciliationRequired !== false
    || result.cleanup !== 'synthetic_rows_retained'
    || !Array.isArray(result.tests)
    || JSON.stringify(result.tests) !== JSON.stringify(
      androidLifecycleScenarioPolicy.expectedTestIds.map((id) => ({ id, status: 'PASS' })),
    )
    || !Array.isArray(result.mutations)) {
    fail('RESULT_INVALID');
  }
  const traceIndex = passedMutationTraceIndex(result.mutations);
  if (traceIndex < 0
    || result.measurements.recoveredRetranscribe !== (traceIndex === 0 ? 1 : 0)) fail('RESULT_INVALID');
  return true;
}

export function assertAndroidLifecycleOperationalStatus(resultStatus, requirePassed = true) {
  if (!['passed', 'failed_closed'].includes(resultStatus)) fail('RESULT_INVALID');
  if (requirePassed && resultStatus !== 'passed') fail('OPERATIONAL_QUALIFICATION_FAILED');
  return true;
}

export function assertFailedClosedInspectionStatus(resultStatus) {
  if (resultStatus !== 'failed_closed') fail('FAILED_CLOSED_EVIDENCE_REQUIRED');
  return true;
}

export function verifyAndroidLifecycleEvidence(root, {
  requireOperational = true,
  requirePassed = true,
} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || !root.startsWith(`${INTERNAL_OUTPUT_ROOT}/`) || realpathSync(root) !== root) fail('EVIDENCE_ROOT_INVALID');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700
    || statSync(root).dev !== statSync('/').dev) fail('EVIDENCE_ROOT_INVALID');
  const entries = readdirSync(root).sort();
  const terminalNames = entries.filter((name) => /^terminal-(?:success|failure|test-only)\.json$/u.test(name));
  if (terminalNames.length !== 1
    || JSON.stringify(entries) !== JSON.stringify(['attempt.json', 'mutations', 'result.json', terminalNames[0]].sort())) {
    fail('EVIDENCE_ROOT_CLOSURE_INVALID');
  }
  const mutationRoot = join(root, 'mutations');
  const mutationStat = lstatSync(mutationRoot);
  if (!mutationStat.isDirectory() || mutationStat.isSymbolicLink() || (mutationStat.mode & 0o777) !== 0o700) {
    fail('MUTATION_ROOT_INVALID');
  }

  const attemptPath = join(root, 'attempt.json');
  const resultPath = join(root, 'result.json');
  const terminalPath = join(root, terminalNames[0]);
  const attempt = exactKeys(json(attemptPath, 'ATTEMPT_INVALID'), ATTEMPT_KEYS, 'ATTEMPT_INVALID');
  const result = exactKeys(json(resultPath, 'RESULT_INVALID'), RESULT_KEYS, 'RESULT_INVALID');
  const terminal = exactKeys(json(terminalPath, 'TERMINAL_INVALID'), TERMINAL_KEYS, 'TERMINAL_INVALID');
  if (attempt.schemaVersion !== 'maina.android-lifecycle-attempt.v3' || attempt.status !== 'running'
    || !['native', 'injected_test'].includes(attempt.executionMode)
    || terminal.schemaVersion !== 'maina.android-lifecycle-terminal.v2'
    || terminal.executionMode !== attempt.executionMode
    || terminal.status !== result.status || terminal.reasonCode !== result.reasonCode
    || terminal.reconciliationRequired !== result.reconciliationRequired
    || terminal.attemptSha256 !== sha256File(attemptPath) || terminal.resultSha256 !== sha256File(resultPath)
    || attempt.rawDeviceOutputPersisted !== false || attempt.physicalIncomingCallTestPerformed !== false
    || !SHA256.test(attempt.serialSha256)
    || attempt.attemptRoot !== root
    || typeof attempt.attemptNonce !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attempt.attemptNonce)) fail('EVIDENCE_BINDING_INVALID');
  if (requireOperational && attempt.executionMode !== 'native') fail('OPERATIONAL_EVIDENCE_REQUIRED');
  if ((attempt.executionMode === 'native') !== (terminalNames[0] !== 'terminal-test-only.json')) fail('TERMINAL_CLASS_INVALID');
  if (Date.parse(attempt.startedAt) > Date.parse(terminal.completedAt)) fail('EVIDENCE_TIME_INVALID');
  if (Number.isNaN(Date.parse(attempt.startedAt)) || Number.isNaN(Date.parse(terminal.completedAt))) fail('EVIDENCE_TIME_INVALID');
  if (terminalNames[0] === 'terminal-success.json'
    && (result.status !== 'passed' || result.reconciliationRequired !== false)) fail('TERMINAL_CLASS_INVALID');
  if (terminalNames[0] === 'terminal-failure.json' && result.status !== 'failed_closed') fail('TERMINAL_CLASS_INVALID');

  for (const record of [attempt.plan, attempt.provenance, attempt.artifact, attempt.source, attempt.node, attempt.adb, attempt.git]) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('ATTEMPT_BINDING_INVALID');
  }
  verifyLooseFileRecord(attempt.plan, 'ATTEMPT_BINDING_INVALID');
  verifyLooseFileRecord(attempt.provenance, 'ATTEMPT_BINDING_INVALID');
  exactKeys(attempt.artifact, ['bytes', 'mode', 'path', 'sha256', 'signerCertificateSha256'], 'ATTEMPT_BINDING_INVALID');
  exactKeys(attempt.node, ['bytes', 'mode', 'path', 'sha256', 'version'], 'NODE_BINDING_INVALID');
  if (!Number.isSafeInteger(attempt.node.bytes) || attempt.node.bytes <= 0
    || !Number.isSafeInteger(attempt.node.mode) || attempt.node.mode < 0 || attempt.node.mode > 0o777
    || !SHA256.test(attempt.node.sha256) || !/^\d+\.\d+\.\d+$/u.test(attempt.node.version)) fail('NODE_BINDING_INVALID');
  exactKeys(attempt.adb, ['bytes', 'mode', 'path', 'sha256', 'version'], 'ADB_BINDING_INVALID');
  if (!Number.isSafeInteger(attempt.adb.bytes) || attempt.adb.bytes <= 0
    || !Number.isSafeInteger(attempt.adb.mode) || (attempt.adb.mode & 0o111) === 0
    || !SHA256.test(attempt.adb.sha256) || typeof attempt.adb.version !== 'string') fail('ADB_BINDING_INVALID');
  exactKeys(attempt.git, ['bytes', 'mode', 'path', 'sha256', 'version'], 'GIT_BINDING_INVALID');
  if (!Number.isSafeInteger(attempt.git.bytes) || attempt.git.bytes <= 0
    || !Number.isSafeInteger(attempt.git.mode) || (attempt.git.mode & 0o111) === 0
    || attempt.git.path !== CANONICAL_GIT || attempt.git.sha256 !== CANONICAL_GIT_SHA256
    || attempt.git.version !== CANONICAL_GIT_VERSION) fail('GIT_BINDING_INVALID');
  verifyLooseFileRecord(attempt.ledger, 'ATTEMPT_LEDGER_INVALID');
  exactFile(attempt.node.path, {
    path: attempt.node.path,
    sha256: attempt.node.sha256,
    bytes: attempt.node.bytes,
    mode: attempt.node.mode,
  }, 'NODE_BINDING_INVALID', attempt.node.mode);
  exactFile(attempt.adb.path, { path: attempt.adb.path, sha256: attempt.adb.sha256, bytes: attempt.adb.bytes, mode: attempt.adb.mode }, 'ADB_BINDING_INVALID', attempt.adb.mode);
  exactFile(attempt.git.path, { path: attempt.git.path, sha256: attempt.git.sha256, bytes: attempt.git.bytes, mode: attempt.git.mode }, 'GIT_BINDING_INVALID', attempt.git.mode);
  if (attempt.executionMode === 'native' && (attempt.adb.path !== CANONICAL_ADB
    || attempt.adb.sha256 !== CANONICAL_ADB_SHA256 || attempt.adb.version !== CANONICAL_ADB_VERSION)) fail('ADB_BINDING_INVALID');
  exactFile(attempt.artifact.path, {
    path: attempt.artifact.path,
    sha256: attempt.artifact.sha256,
    bytes: attempt.artifact.bytes,
    mode: attempt.artifact.mode,
  }, 'ARTIFACT_BINDING_INVALID', attempt.artifact.mode);
  exactFile(attempt.plan.path, attempt.plan, 'RELEASE_BINDING_INVALID', attempt.plan.mode);
  exactFile(attempt.provenance.path, attempt.provenance, 'RELEASE_BINDING_INVALID', attempt.provenance.mode);
  exactFile(attempt.ledger.path, attempt.ledger, 'ATTEMPT_LEDGER_INVALID', 0o600);
  const ledgerRoot = dirname(attempt.ledger.path);
  const ledgerRootStat = lstatSync(ledgerRoot);
  if (!ledgerRoot.startsWith(`${INTERNAL_OUTPUT_ROOT}/`) || resolve(ledgerRoot) !== ledgerRoot
    || !ledgerRootStat.isDirectory() || ledgerRootStat.isSymbolicLink()
    || realpathSync(ledgerRoot) !== ledgerRoot || (ledgerRootStat.mode & 0o777) !== 0o700
    || ledgerRootStat.dev !== statSync('/').dev
    || attempt.ledger.path !== join(ledgerRoot, `${attempt.attemptNonce}.json`)
    || (attempt.executionMode === 'native' && ledgerRoot !== DEFAULT_LEDGER_ROOT)) fail('ATTEMPT_LEDGER_INVALID');
  const ledger = exactKeys(json(attempt.ledger.path, 'ATTEMPT_LEDGER_INVALID'), [
    'attemptNonce', 'attemptRoot', 'releaseId', 'schemaVersion',
  ], 'ATTEMPT_LEDGER_INVALID');
  if (ledger.schemaVersion !== 'maina.android-lifecycle-attempt-ledger.v1'
    || ledger.attemptNonce !== attempt.attemptNonce || ledger.attemptRoot !== root
    || ledger.releaseId !== attempt.releaseId) fail('ATTEMPT_LEDGER_INVALID');
  if (!SHA256.test(attempt.artifact.signerCertificateSha256)
    || !isAbsolute(attempt.plan.path) || !isAbsolute(attempt.provenance.path)
    || attempt.plan.sha256 !== sha256File(attempt.plan.path)
    || attempt.provenance.sha256 !== sha256File(attempt.provenance.path)) fail('RELEASE_BINDING_INVALID');
  const plan = parseJsonBytesRejectDuplicateKeys(readFileSync(attempt.plan.path), 'plan');
  const provenance = parseJsonBytesRejectDuplicateKeys(readFileSync(attempt.provenance.path), 'provenance');
  try {
    validateApprovedRelease(provenance, plan, { planSha256: attempt.plan.sha256 });
  } catch {
    fail('RELEASE_BINDING_INVALID');
  }
  if (attempt.releaseId !== provenance.releaseId
    || attempt.expectedVersion !== provenance.artifacts.android.audit.versionName
    || attempt.expectedBuild !== provenance.artifacts.android.audit.versionCode
    || attempt.artifact.path !== provenance.artifacts.android.path
    || attempt.artifact.sha256 !== provenance.artifacts.android.sha256
    || attempt.artifact.bytes !== provenance.artifacts.android.bytes
    || attempt.artifact.signerCertificateSha256 !== provenance.artifacts.android.audit.signerCertificateSha256
    || !Array.isArray(provenance.approval?.authorization?.scope)
    || !provenance.approval.authorization.scope.includes('automated-device-qualification:android')) {
    fail('RELEASE_BINDING_INVALID');
  }
  verifyQualificationSource(
    attempt.source,
    attempt.expectedVersion,
    provenance.sources.android,
  );
  if (!exactKeys(attempt.node, ['bytes', 'mode', 'path', 'sha256', 'version'], 'NODE_BINDING_INVALID')
    || attempt.node.path !== plan.toolchains.nodeExecutablePath
    || attempt.node.sha256 !== plan.toolchains.nodeExecutableSha256
    || attempt.node.version !== plan.toolchains.node) fail('NODE_BINDING_INVALID');

  if (!Array.isArray(attempt.runtimeFiles) || attempt.runtimeFiles.length !== RUNTIME_PATHS.length) fail('RUNTIME_BINDING_INVALID');
  const runtimeNames = new Set();
  for (const record of attempt.runtimeFiles) {
    verifyLooseFileRecord(record, 'RUNTIME_BINDING_INVALID', { pathKey: false });
    if (typeof record.relativePath !== 'string' || !RUNTIME_PATHS.includes(record.relativePath)
      || runtimeNames.has(record.relativePath)) fail('RUNTIME_BINDING_INVALID');
    runtimeNames.add(record.relativePath);
    const committed = gitFileRecord(
      attempt.source.repository,
      attempt.source.qualificationCommit,
      record.relativePath,
      'RUNTIME_BINDING_INVALID',
    );
    if (committed.bytes !== record.bytes || committed.mode !== record.mode
      || committed.sha256 !== record.sha256) fail('RUNTIME_BINDING_INVALID');
  }
  if (JSON.stringify([...runtimeNames].sort()) !== JSON.stringify([...RUNTIME_PATHS].sort())) fail('RUNTIME_BINDING_INVALID');

  validateMeasurements(result.measurements, result.status === 'passed');
  if (!Array.isArray(result.tests)
    || result.tests.some((entry) => !exactKeys(entry, ['id', 'status'], 'RESULT_TESTS_INVALID') || entry.status !== 'PASS')
    || JSON.stringify(result.tests.map(({ id }) => id))
      !== JSON.stringify(androidLifecycleScenarioPolicy.expectedTestIds.slice(0, result.tests.length))) {
    fail('RESULT_TESTS_INVALID');
  }
  if (!['passed', 'failed_closed'].includes(result.status)
    || (result.reasonCode !== null && (typeof result.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/u.test(result.reasonCode)))
    || typeof result.reconciliationRequired !== 'boolean'
    || !['synthetic_rows_retained', 'no_automatic_mutation_after_failure'].includes(result.cleanup)) fail('RESULT_INVALID');
  if (result.status === 'passed' && (result.reasonCode !== null
    || result.reconciliationRequired || result.cleanup !== 'synthetic_rows_retained'
    || result.tests.length !== androidLifecycleScenarioPolicy.expectedTestIds.length)) fail('RESULT_INVALID');
  if (result.status === 'failed_closed' && (result.reasonCode === null
    || result.cleanup !== 'no_automatic_mutation_after_failure')) fail('RESULT_INVALID');
  if (result.status === 'passed') validatePassedAndroidLifecycleResult(result);
  assertAndroidLifecycleOperationalStatus(result.status, requirePassed);

  const journalFiles = readdirSync(mutationRoot).sort();
  if (!Array.isArray(terminal.mutationJournal) || terminal.mutationJournal.length !== journalFiles.length) {
    fail('MUTATION_JOURNAL_INVALID');
  }
  if (journalFiles.length % 2 !== 0) fail('MUTATION_JOURNAL_INVALID');
  const completedProjection = [];
  for (let index = 0; index < journalFiles.length; index += 1) {
    const name = journalFiles[index];
    const record = terminal.mutationJournal[index];
    exactKeys(record, ['bytes', 'mode', 'name', 'sha256'], 'MUTATION_JOURNAL_INVALID');
    const path = join(mutationRoot, name);
    if (record.name !== name || record.mode !== 0o600 || record.bytes !== lstatSync(path).size
      || record.sha256 !== sha256File(path)) fail('MUTATION_JOURNAL_INVALID');
    const entry = exactKeys(json(path, 'MUTATION_JOURNAL_INVALID'), [
      'action', 'attempts', 'id', 'payloadDigest', 'payloadShape', 'schemaVersion', 'sequence', 'state',
    ], 'MUTATION_JOURNAL_INVALID');
    if (entry.schemaVersion !== 'maina.android-lifecycle-mutation.v3' || entry.sequence !== index + 1
      || entry.attempts !== 1 || !['issued', 'confirmed_applied', 'confirmed_no_effect', 'ambiguous'].includes(entry.state)) {
      fail('MUTATION_JOURNAL_INVALID');
    }
    if (name !== `${String(entry.sequence).padStart(3, '0')}-${entry.id}-${entry.state}.json`
      || !['arm_qualification', 'force_stop', 'launch_main', 'launch_record_qualification', 'press_back', 'press_home', 'sleep_device', 'tap', 'wake_up'].includes(entry.action)
      || JSON.stringify(entry.payloadShape) !== JSON.stringify(
        entry.action === 'tap' ? ['x', 'y'] : ['arm_qualification', 'launch_record_qualification'].includes(entry.action) ? ['qualificationRunId'] : [],
      )
      || (['arm_qualification', 'launch_record_qualification'].includes(entry.action)
        ? typeof entry.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.payloadDigest)
        : entry.payloadDigest !== null)) fail('MUTATION_JOURNAL_INVALID');
    if (['arm_qualification', 'launch_record_qualification'].includes(entry.action)) {
      const slot = entry.id.includes('-normal') ? 'normal' : entry.id.includes('-recovery') ? 'recovery' : null;
      if (slot === null || entry.payloadDigest !== deriveQualificationEvidenceDigest(
        deriveQualificationRecordingRunId(attempt.attemptNonce, slot),
      )) fail('MUTATION_JOURNAL_INVALID');
    }
    if (index % 2 === 0) {
      if (entry.state !== 'issued') fail('MUTATION_JOURNAL_INVALID');
      continue;
    }
    const issued = exactKeys(json(join(mutationRoot, journalFiles[index - 1]), 'MUTATION_JOURNAL_INVALID'), [
      'action', 'attempts', 'id', 'payloadDigest', 'payloadShape', 'schemaVersion', 'sequence', 'state',
    ], 'MUTATION_JOURNAL_INVALID');
    if (entry.state === 'issued' || issued.state !== 'issued'
      || entry.id !== issued.id || entry.action !== issued.action
      || entry.payloadDigest !== issued.payloadDigest
      || JSON.stringify(entry.payloadShape) !== JSON.stringify(issued.payloadShape)) fail('MUTATION_JOURNAL_INVALID');
    completedProjection.push(Object.freeze({
      id: entry.id,
      action: entry.action,
      payloadDigest: entry.payloadDigest,
      payloadShape: entry.payloadShape,
      state: entry.state,
      attempts: entry.attempts,
    }));
  }
  if (!Array.isArray(result.mutations)
    || JSON.stringify(result.mutations) !== JSON.stringify(completedProjection)) fail('MUTATION_RESULT_MISMATCH');
  if (result.status === 'passed' && passedMutationTraceIndex(result.mutations) < 0) fail('MUTATION_RESULT_MISMATCH');
  return Object.freeze({
    status: 'verified',
    operationalEvidence: attempt.executionMode === 'native',
    resultStatus: result.status,
    releaseId: attempt.releaseId,
  });
}

async function main() {
  try {
    const inspectFailedClosed = process.argv[2] === '--inspect-failed-closed';
    const root = inspectFailedClosed ? process.argv[3] : process.argv[2];
    if (process.argv.length !== (inspectFailedClosed ? 4 : 3)) fail('EVIDENCE_ARGUMENT_INVALID');
    const verified = verifyAndroidLifecycleEvidence(root, {
      requireOperational: true,
      requirePassed: !inspectFailedClosed,
    });
    if (inspectFailedClosed) assertFailedClosedInspectionStatus(verified.resultStatus);
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  } catch (error) {
    const reasonCode = error instanceof AndroidLifecycleEvidenceFailure ? error.code : 'EVIDENCE_VERIFICATION_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'failed_closed', reasonCode })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
