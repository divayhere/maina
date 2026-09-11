#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  AndroidLifecycleRunnerFailure,
  createDurableMutationJournal,
  currentGitState,
  runAndroidLifecycleQualification,
} from './run-android-lifecycle-qualification.mjs';
import {
  assertAndroidLifecycleOperationalStatus,
  assertFailedClosedInspectionStatus,
  AndroidLifecycleEvidenceFailure,
  exactFile,
  exactFileWithIo,
  validatePassedAndroidLifecycleResult,
  verifyAndroidLifecycleEvidence,
} from './verify-android-lifecycle-evidence.mjs';
import { androidLifecycleScenarioPolicy } from './qualification/android-lifecycle-scenario.mjs';

const internalParent = '/Users/divay/.cache/maina-build-v2/outputs';
const suffix = `${process.pid}-${Date.now()}`;
const runnerRoot = join(internalParent, `.android-lifecycle-runner-test-${suffix}`);
const journalRoot = join(internalParent, `.android-lifecycle-journal-test-${suffix}`);
const ledgerRoot = join(internalParent, `.android-lifecycle-ledger-test-${suffix}`);
const wrongNodeRoot = join(internalParent, `.android-lifecycle-wrong-node-test-${suffix}`);
const fakeAdb = join('/tmp', `.maina-fake-adb-${suffix}`);
const fakeGitDir = join('/tmp', `.maina-fake-git-${suffix}`);
const fakeGitSentinel = join(fakeGitDir, 'invoked');
const privateSentinel = 'PRIVATE_DEVICE_OUTPUT_MUST_NOT_PERSIST';
const syntheticArtifactSha256 = 'a'.repeat(64);
const releaseBinding = Object.freeze({
  releaseId: 'maina-synthetic-0.10.69',
  expectedVersion: '0.10.69',
  expectedBuild: 95,
  plan: Object.freeze({ path: '/synthetic/release-plan.json', sha256: 'b'.repeat(64), bytes: 123, mode: 0o600 }),
  provenance: Object.freeze({ path: '/synthetic/provenance.json', sha256: 'c'.repeat(64), bytes: 123, mode: 0o600 }),
  artifact: Object.freeze({
    path: '/synthetic/Maina.apk',
    sha256: syntheticArtifactSha256,
    bytes: 123,
    mode: 0o644,
    signerCertificateSha256: 'd'.repeat(64),
  }),
  node: Object.freeze({
    path: process.execPath,
    sha256: '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1',
    version: process.versions.node,
  }),
  source: Object.freeze({ repository: '/Users/divay/Developer/MainaV2', commit: 'e'.repeat(40) }),
});
let assertions = 0;

const passedMeasurements = Object.freeze({
  firstTimerSeconds: 0,
  secondTimerSeconds: 3,
  timerAdvanceSeconds: 3,
  firstResumeAcceptedMs: 200,
  pausedTimerSeconds: 6,
  pausedTimerAfterHoldSeconds: 6,
  backgroundTimerAdvanceSeconds: 8,
  screenOffTimerAdvanceSeconds: 8,
  backgroundNativeProgressAdvanced: true,
  screenOffNativeProgressAdvanced: true,
  beforeNormalSaveCount: 10,
  afterNormalSaveCount: 11,
  afterIdleRestartCount: 11,
  beforeRecoveryCount: 11,
  afterRecoveryCount: 12,
  recoveredVisibleCardCount: 1,
  recoveryCorrelation: 'newest_first_count_delta_plus_exact_row_identity',
  recoveredAudioAvailable: 1,
  recoveredPositiveSegments: 1,
  recoveredRetranscribe: 1,
  pausedNativeProgressHeld: true,
  normalSaveNativeInactive: true,
  powerOffObserved: true,
  powerOnObserved: true,
  syntheticMeetingsRetained: 2,
});

function syntheticPayloadDigest(id, action) {
  if (!['arm_qualification', 'launch_record_qualification'].includes(action)) return null;
  return id.includes('-normal') ? 'a'.repeat(64) : 'b'.repeat(64);
}

const passedResult = Object.freeze({
  status: 'passed',
  reasonCode: null,
  tests: androidLifecycleScenarioPolicy.expectedTestIds.map((id) => ({ id, status: 'PASS' })),
  measurements: passedMeasurements,
  mutations: androidLifecycleScenarioPolicy.passedMutationTraces[0].map(([id, action, payloadShape]) => ({
    id,
    action,
    payloadDigest: syntheticPayloadDigest(id, action),
    payloadShape,
    state: 'confirmed_applied',
    attempts: 1,
  })),
  cleanup: 'synthetic_rows_retained',
  reconciliationRequired: false,
});

function commandResult(stdout = '', stderr = '', exitCode = 0) {
  return {
    spawned: true,
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    stdout,
    stderr,
  };
}

try {
  mkdirSync(fakeGitDir, { mode: 0o700 });
  writeFileSync(join(fakeGitDir, 'git'), `#!/bin/sh\n: > '${fakeGitSentinel}'\nexit 0\n`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeGitDir}:${originalPath ?? ''}`;
  const gitState = currentGitState();
  process.env.PATH = originalPath;
  assert.match(gitState.head, /^[0-9a-f]{40}$/u);
  assert.equal(lstatSync(fakeGitSentinel, { throwIfNoEntry: false }), undefined);
  assertions += 2;
  writeFileSync(fakeAdb, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  chmodSync(fakeAdb, 0o700);
  assert.equal(validatePassedAndroidLifecycleResult(passedResult), true);
  assert.throws(
    () => validatePassedAndroidLifecycleResult({ ...passedResult, measurements: { ...passedMeasurements, timerAdvanceSeconds: null } }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_MEASUREMENTS_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({ ...passedResult, mutations: [] }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({
      ...passedResult,
      mutations: passedResult.mutations.map((entry, index) => index === 0 ? { ...entry, state: 'ambiguous' } : entry),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({
      ...passedResult,
      mutations: passedResult.mutations.map((entry, index) => index === 0 ? { ...entry, action: 'tap', payloadShape: ['x', 'y'] } : entry),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({
      ...passedResult,
      mutations: passedResult.mutations.map((entry) => (
        entry.id === 'launch-start-normal'
          ? { ...entry, payloadDigest: 'b'.repeat(64) }
          : entry
      )),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({
      ...passedResult,
      mutations: passedResult.mutations.map((entry) => (
        entry.action === 'arm_qualification' && entry.id.includes('-recovery')
          ? { ...entry, payloadDigest: 'a'.repeat(64) }
          : entry.action === 'launch_record_qualification' && entry.id.includes('-recovery')
            ? { ...entry, payloadDigest: 'a'.repeat(64) }
            : entry
      )),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.throws(
    () => validatePassedAndroidLifecycleResult({
      ...passedResult,
      mutations: androidLifecycleScenarioPolicy.passedMutationTraces[1].map(([id, action, payloadShape]) => ({
        id,
        action,
        payloadDigest: syntheticPayloadDigest(id, action),
        payloadShape,
        state: 'confirmed_applied',
        attempts: 1,
      })),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.equal(validatePassedAndroidLifecycleResult({
    ...passedResult,
    measurements: { ...passedMeasurements, recoveredRetranscribe: 0 },
    mutations: androidLifecycleScenarioPolicy.passedMutationTraces[1].map(([id, action, payloadShape]) => ({
      id,
      action,
      payloadDigest: syntheticPayloadDigest(id, action),
      payloadShape,
      state: 'confirmed_applied',
      attempts: 1,
    })),
  }), true);
  assertions += 9;
  await assert.rejects(
    () => runAndroidLifecycleQualification({
      env: {
        MAINA_ANDROID_LIFECYCLE_QUALIFICATION_RELEASE: 'approved',
        MAINA_ANDROID_LIFECYCLE_TEST_MODE: 'approved',
        MAINA_ADB: fakeAdb,
        MAINA_ADB_SERIAL: 'adb-synthetic._adb-tls-connect._tcp',
        MAINA_ANDROID_LIFECYCLE_ATTEMPT_ROOT: wrongNodeRoot,
        MAINA_ANDROID_LIFECYCLE_LEDGER_ROOT: ledgerRoot,
      },
      releaseBinding: { ...releaseBinding, node: { ...releaseBinding.node, version: '26.7.0' } },
      attemptNonce: '00000000-0000-4000-8000-000000000099',
      run: () => { throw new Error('COMMAND_MUST_NOT_RUN'); },
    }),
    (error) => error instanceof AndroidLifecycleRunnerFailure && error.code === 'NODE_BINARY_INVALID',
  );
  assert.equal(lstatSync(internalParent).isDirectory(), true);
  assert.equal(readdirSync(internalParent).includes(`.android-lifecycle-wrong-node-test-${suffix}`), false);
  assertions += 3;
  let commandCount = 0;
  const result = await runAndroidLifecycleQualification({
    env: {
      MAINA_ANDROID_LIFECYCLE_QUALIFICATION_RELEASE: 'approved',
      MAINA_ANDROID_LIFECYCLE_TEST_MODE: 'approved',
      MAINA_ADB: fakeAdb,
      MAINA_ADB_SERIAL: 'adb-synthetic._adb-tls-connect._tcp',
      MAINA_ANDROID_LIFECYCLE_ATTEMPT_ROOT: runnerRoot,
      MAINA_ANDROID_LIFECYCLE_LEDGER_ROOT: ledgerRoot,
    },
    releaseBinding,
    attemptNonce: '00000000-0000-4000-8000-000000000001',
    run: (_command, args) => {
      commandCount += 1;
      assert.deepEqual(args, ['-s', 'adb-synthetic._adb-tls-connect._tcp', 'shell', 'dumpsys', 'package', 'com.divay.maina']);
      return commandResult(
        `Package [com.divay.maina] (123):\n  versionCode=93 minSdk=24 targetSdk=36\n  versionName=0.10.67\n${privateSentinel}\n`,
      );
    },
    now: () => 0,
    sleep: async () => {},
  });
  assert.equal(result.status, 'failed_closed');
  assert.equal(result.reasonCode, 'INSTALLED_IDENTITY_MISMATCH');
  assert.equal(commandCount, 1);
  assert.equal((statSync(runnerRoot).mode & 0o777), 0o700);
  assert.deepEqual(readdirSync(join(runnerRoot, 'mutations')), []);
  assert.equal((statSync(join(runnerRoot, 'result.json')).mode & 0o777), 0o600);
  assert.equal(readdirSync(runnerRoot).includes('terminal-test-only.json'), true);
  const persisted = readdirSync(runnerRoot)
    .filter((file) => lstatSync(join(runnerRoot, file)).isFile())
    .map((file) => readFileSync(join(runnerRoot, file), { encoding: 'utf8', flag: 'r' }))
    .join('\n');
  assert.equal(persisted.includes(privateSentinel), false);
  assertions += 8;

  assert.throws(
    () => verifyAndroidLifecycleEvidence(runnerRoot),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'OPERATIONAL_EVIDENCE_REQUIRED',
  );
  assert.equal(assertAndroidLifecycleOperationalStatus('passed'), true);
  assert.equal(assertAndroidLifecycleOperationalStatus('failed_closed', false), true);
  assert.throws(
    () => assertAndroidLifecycleOperationalStatus('failed_closed'),
    (error) => error instanceof AndroidLifecycleEvidenceFailure &&
      error.code === 'OPERATIONAL_QUALIFICATION_FAILED',
  );
  assert.throws(
    () => assertAndroidLifecycleOperationalStatus('unknown'),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'RESULT_INVALID',
  );
  assert.equal(assertFailedClosedInspectionStatus('failed_closed'), true);
  assert.throws(
    () => assertFailedClosedInspectionStatus('passed'),
    (error) => error instanceof AndroidLifecycleEvidenceFailure &&
      error.code === 'FAILED_CLOSED_EVIDENCE_REQUIRED',
  );
  assert.throws(
    () => exactFile(join('/tmp', `.maina-missing-artifact-${suffix}`), null, 'ARTIFACT_BINDING_INVALID'),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'ARTIFACT_BINDING_INVALID',
  );
  const fakeStats = Object.freeze({
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    size: 3,
  });
  const fsFailure = Object.assign(new Error('not retained'), { code: 'EIO', syscall: 'read' });
  assert.throws(
    () => exactFileWithIo('/private/evidence', null, 'ARTIFACT_BINDING_INVALID', 0o600, {
      lstat: () => { throw fsFailure; },
      sha256: () => 'a'.repeat(64),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'ARTIFACT_BINDING_INVALID',
  );
  const programmerFailure = new TypeError('sentinel programmer failure');
  assert.throws(
    () => exactFileWithIo('/private/evidence', null, 'ARTIFACT_BINDING_INVALID', 0o600, {
      lstat: () => { throw programmerFailure; },
      sha256: () => 'a'.repeat(64),
    }),
    (error) => error === programmerFailure,
  );
  assert.throws(
    () => exactFileWithIo(42, null, 'ARTIFACT_BINDING_INVALID', 0o600, {
      lstat: () => fakeStats,
      sha256: () => 'a'.repeat(64),
    }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'ARTIFACT_BINDING_INVALID',
  );
  assertions += 11;

  const terminalPath = join(runnerRoot, 'terminal-test-only.json');
  const terminalBytes = readFileSync(terminalPath, 'utf8');
  const terminal = JSON.parse(terminalBytes);
  writeFileSync(terminalPath, `${JSON.stringify({ ...terminal, unexpected: true }, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => verifyAndroidLifecycleEvidence(runnerRoot, { requireOperational: false }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'TERMINAL_INVALID',
  );
  writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
  const attemptPath = join(runnerRoot, 'attempt.json');
  const attemptBytes = readFileSync(attemptPath, 'utf8');
  const attempt = JSON.parse(attemptBytes);
  const writeAttemptMutation = (value) => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(attemptPath, bytes, { mode: 0o600 });
    writeFileSync(terminalPath, `${JSON.stringify({
      ...terminal,
      attemptSha256: createHash('sha256').update(bytes).digest('hex'),
    }, null, 2)}\n`, { mode: 0o600 });
  };
  writeAttemptMutation({ ...attempt, adb: { ...attempt.adb, sha256: '0'.repeat(64) } });
  assert.throws(
    () => verifyAndroidLifecycleEvidence(runnerRoot, { requireOperational: false }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'ADB_BINDING_INVALID',
  );
  writeAttemptMutation({ ...attempt, git: { ...attempt.git, sha256: '0'.repeat(64) } });
  assert.throws(
    () => verifyAndroidLifecycleEvidence(runnerRoot, { requireOperational: false }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'GIT_BINDING_INVALID',
  );
  writeFileSync(attemptPath, attemptBytes, { mode: 0o600 });
  writeFileSync(terminalPath, terminalBytes, { mode: 0o600 });
  writeFileSync(join(runnerRoot, 'unexpected.json'), '{}\n', { mode: 0o600 });
  assert.throws(
    () => verifyAndroidLifecycleEvidence(runnerRoot, { requireOperational: false }),
    (error) => error instanceof AndroidLifecycleEvidenceFailure && error.code === 'EVIDENCE_ROOT_CLOSURE_INVALID',
  );
  rmSync(join(runnerRoot, 'unexpected.json'));
  assertions += 4;

  await assert.rejects(
    () => runAndroidLifecycleQualification({
      env: {
        MAINA_ANDROID_LIFECYCLE_QUALIFICATION_RELEASE: 'approved',
        MAINA_ANDROID_LIFECYCLE_TEST_MODE: 'approved',
        MAINA_ADB: fakeAdb,
        MAINA_ADB_SERIAL: 'adb-synthetic._adb-tls-connect._tcp',
        MAINA_ANDROID_LIFECYCLE_ATTEMPT_ROOT: runnerRoot,
        MAINA_ANDROID_LIFECYCLE_LEDGER_ROOT: ledgerRoot,
      },
      releaseBinding,
      attemptNonce: '00000000-0000-4000-8000-000000000002',
      run: () => {
        throw new Error('COMMAND_MUST_NOT_RUN');
      },
    }),
    (error) => error instanceof AndroidLifecycleRunnerFailure && error.code === 'ATTEMPT_ALREADY_EXISTS',
  );
  assertions += 1;

  mkdirSync(journalRoot, { mode: 0o700 });
  const journal = createDurableMutationJournal(journalRoot);
  await journal({ id: 'tap-start-test', action: 'tap', payloadDigest: null, payloadShape: ['x', 'y'], state: 'issued', attempts: 1 });
  await journal({ id: 'tap-start-test', action: 'tap', payloadDigest: null, payloadShape: ['x', 'y'], state: 'confirmed_applied', attempts: 1 });
  const journalFiles = readdirSync(join(journalRoot, 'mutations'));
  assert.deepEqual(journalFiles, [
    '001-tap-start-test-issued.json',
    '002-tap-start-test-confirmed_applied.json',
  ]);
  assert.equal(journalFiles.every((file) => (lstatSync(join(journalRoot, 'mutations', file)).mode & 0o777) === 0o600), true);
  await assert.rejects(
    () => journal({ id: 'tap-start-test', action: 'tap', payloadDigest: null, payloadShape: ['x', 'y'], state: 'issued', attempts: 1 }),
    (error) => error instanceof AndroidLifecycleRunnerFailure && error.code === 'MUTATION_JOURNAL_TRANSITION_INVALID',
  );
  await assert.rejects(
    () => journal({ id: 'tap-invalid-test', action: 'tap', payloadDigest: null, payloadShape: [], state: 'issued', attempts: 1 }),
    (error) => error instanceof AndroidLifecycleRunnerFailure && error.code === 'MUTATION_JOURNAL_ENTRY_INVALID',
  );
  await journal({ id: 'action-mismatch-test', action: 'tap', payloadDigest: null, payloadShape: ['x', 'y'], state: 'issued', attempts: 1 });
  await assert.rejects(
    () => journal({ id: 'action-mismatch-test', action: 'force_stop', payloadDigest: null, payloadShape: [], state: 'confirmed_applied', attempts: 1 }),
    (error) => error instanceof AndroidLifecycleRunnerFailure && error.code === 'MUTATION_JOURNAL_TRANSITION_INVALID',
  );
  assertions += 6;
} finally {
  rmSync(runnerRoot, { recursive: true, force: true });
  rmSync(journalRoot, { recursive: true, force: true });
  rmSync(ledgerRoot, { recursive: true, force: true });
  rmSync(wrongNodeRoot, { recursive: true, force: true });
  rmSync(fakeAdb, { force: true });
  rmSync(fakeGitDir, { recursive: true, force: true });
}

console.log(`Android lifecycle operational runner verified (${assertions} durable-boundary assertions; zero device commands).`);
