#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { authorizeExactArtifact, sha256File, validateApprovedRelease } from './lib/release-provenance-core.mjs';
import { parseJsonBytesRejectDuplicateKeys } from './lib/strict-json.mjs';
import { createAndroidLifecycleAdbTools } from './qualification/android-lifecycle-adapter.mjs';
import { executeAndroidLifecycleScenario } from './qualification/android-lifecycle-scenario.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
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

export class AndroidLifecycleRunnerFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'AndroidLifecycleRunnerFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new AndroidLifecycleRunnerFailure(code);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function regularFile(path, code, { executable = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(code);
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || (executable && (value.mode & 0o111) === 0)) fail(code);
  return value;
}

function fileRecord(path, code, options) {
  const value = regularFile(path, code, options);
  return Object.freeze({
    path,
    sha256: sha256File(path),
    bytes: value.size,
    mode: value.mode & 0o777,
  });
}

function strictJsonFile(path, code) {
  regularFile(path, code);
  try {
    return parseJsonBytesRejectDuplicateKeys(readFileSync(path), code);
  } catch {
    fail(code);
  }
}

function gitOutput(args, code) {
  const result = spawnSync(CANONICAL_GIT, ['-C', PROJECT_ROOT, ...args], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0 || result.signal !== null || result.stderr !== '') fail(code);
  return result.stdout.trim();
}

function canonicalGitRecord() {
  const record = fileRecord(CANONICAL_GIT, 'GIT_BINARY_INVALID', { executable: true });
  const version = spawnSync(CANONICAL_GIT, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (record.sha256 !== CANONICAL_GIT_SHA256 || version.status !== 0 || version.signal !== null
    || version.stderr !== '' || version.stdout.trim() !== CANONICAL_GIT_VERSION) fail('GIT_BINARY_INVALID');
  return Object.freeze({ ...record, version: CANONICAL_GIT_VERSION });
}

function canonicalAdbVersion() {
  const result = spawnSync(CANONICAL_ADB, ['version'], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0 || result.signal !== null || result.stderr !== '') fail('ADB_BINARY_INVALID');
  const matches = result.stdout.match(/^Version ([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)$/gmu) ?? [];
  if (matches.length !== 1 || matches[0] !== `Version ${CANONICAL_ADB_VERSION}`) fail('ADB_BINARY_INVALID');
  return CANONICAL_ADB_VERSION;
}

export function currentGitState() {
  const head = gitOutput(['rev-parse', 'HEAD'], 'SOURCE_STATE_UNAVAILABLE');
  const upstream = gitOutput(['rev-parse', '@{u}'], 'SOURCE_STATE_UNAVAILABLE');
  const status = gitOutput(['status', '--porcelain=v1', '--untracked-files=all'], 'SOURCE_STATE_UNAVAILABLE');
  return Object.freeze({ head, upstream, clean: status === '' });
}

function validateReleaseBindingShape(binding) {
  if (!exactKeys(binding, [
    'artifact', 'expectedBuild', 'expectedVersion', 'node', 'plan', 'provenance', 'releaseId', 'source',
  ])
    || typeof binding.releaseId !== 'string' || !/^maina-[a-z0-9.-]{3,120}$/u.test(binding.releaseId)
    || typeof binding.expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(binding.expectedVersion)
    || !Number.isSafeInteger(binding.expectedBuild) || binding.expectedBuild <= 0
    || !exactKeys(binding.plan, ['bytes', 'mode', 'path', 'sha256']) || !isAbsolute(binding.plan.path) || !SHA256.test(binding.plan.sha256)
    || !exactKeys(binding.provenance, ['bytes', 'mode', 'path', 'sha256']) || !isAbsolute(binding.provenance.path) || !SHA256.test(binding.provenance.sha256)
    || !exactKeys(binding.artifact, ['bytes', 'mode', 'path', 'sha256', 'signerCertificateSha256'])
    || !isAbsolute(binding.artifact.path) || !SHA256.test(binding.artifact.sha256)
    || !SHA256.test(binding.artifact.signerCertificateSha256)
    || ![binding.plan, binding.provenance, binding.artifact].every((record) => (
      Number.isSafeInteger(record.bytes) && record.bytes > 0
      && Number.isSafeInteger(record.mode) && record.mode >= 0 && record.mode <= 0o777
    ))
    || !exactKeys(binding.node, ['path', 'sha256', 'version']) || !isAbsolute(binding.node.path)
    || !SHA256.test(binding.node.sha256) || !/^\d+\.\d+\.\d+$/u.test(binding.node.version)
    || !exactKeys(binding.source, ['commit', 'repository']) || binding.source.repository !== PROJECT_ROOT
    || !/^[0-9a-f]{40}$/u.test(binding.source.commit)) fail('RELEASE_BINDING_INVALID');
  return binding;
}

export function loadApprovedAndroidReleaseBinding(env = process.env) {
  const planPath = env.MAINA_RELEASE_PLAN;
  const provenancePath = env.MAINA_RELEASE_PROVENANCE;
  if (typeof planPath !== 'string' || typeof provenancePath !== 'string') fail('RELEASE_BINDING_INVALID');
  const plan = strictJsonFile(planPath, 'RELEASE_PLAN_INVALID');
  const provenance = strictJsonFile(provenancePath, 'RELEASE_PROVENANCE_INVALID');
  const planSha256 = sha256File(planPath);
  try {
    validateApprovedRelease(provenance, plan, { planSha256 });
    authorizeExactArtifact({
      provenance,
      plan,
      platform: 'android',
      artifactPath: provenance.artifacts.android.path,
      planSha256,
    });
  } catch {
    fail('RELEASE_AUTHORIZATION_INVALID');
  }
  const state = currentGitState();
  const source = provenance.sources.android;
  if (plan.sources.android.repository !== PROJECT_ROOT || source.repository !== PROJECT_ROOT
    || !state.clean || state.head !== state.upstream || state.head !== source.finalCommit) {
    fail('SOURCE_CUSTODY_INVALID');
  }
  const planRecord = fileRecord(planPath, 'RELEASE_PLAN_INVALID');
  const provenanceRecord = fileRecord(provenancePath, 'RELEASE_PROVENANCE_INVALID');
  const artifactRecord = fileRecord(provenance.artifacts.android.path, 'RELEASE_ARTIFACT_INVALID');
  if (!plan.toolchains || typeof plan.toolchains !== 'object' || Array.isArray(plan.toolchains)
    || typeof plan.toolchains.nodeExecutablePath !== 'string'
    || typeof plan.toolchains.nodeExecutableSha256 !== 'string'
    || typeof plan.toolchains.node !== 'string') fail('RELEASE_TOOLCHAIN_INVALID');
  return validateReleaseBindingShape(Object.freeze({
    releaseId: provenance.releaseId,
    expectedVersion: provenance.artifacts.android.audit.versionName,
    expectedBuild: provenance.artifacts.android.audit.versionCode,
    plan: Object.freeze({ path: planPath, sha256: planSha256, bytes: planRecord.bytes, mode: planRecord.mode }),
    provenance: Object.freeze({ path: provenancePath, sha256: provenanceRecord.sha256, bytes: provenanceRecord.bytes, mode: provenanceRecord.mode }),
    artifact: Object.freeze({
      path: provenance.artifacts.android.path,
      sha256: provenance.artifacts.android.sha256,
      bytes: provenance.artifacts.android.bytes,
      mode: artifactRecord.mode,
      signerCertificateSha256: provenance.artifacts.android.audit.signerCertificateSha256,
    }),
    node: Object.freeze({
      path: plan.toolchains.nodeExecutablePath,
      sha256: plan.toolchains.nodeExecutableSha256,
      version: plan.toolchains.node,
    }),
    source: Object.freeze({ repository: PROJECT_ROOT, commit: source.finalCommit }),
  }));
}

function writeExclusiveDurable(path, value) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) fail('EVIDENCE_FILE_MODE_INVALID');
  const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function validateInternalRootPath(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || !root.startsWith(`${INTERNAL_OUTPUT_ROOT}/`) || root.includes('/../')) fail('EVIDENCE_ROOT_INVALID');
  return root;
}

function validateFreshInternalRoot(root) {
  validateInternalRootPath(root);
  const parent = dirname(root);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent) fail('EVIDENCE_PARENT_INVALID');
  if (statSync(parent).dev !== statSync('/').dev) fail('EVIDENCE_DEVICE_INVALID');
  try {
    lstatSync(root);
    fail('ATTEMPT_ALREADY_EXISTS');
  } catch (error) {
    if (error instanceof AndroidLifecycleRunnerFailure) throw error;
    if (error?.code !== 'ENOENT') fail('EVIDENCE_ROOT_INVALID');
  }
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  if ((statSync(root).mode & 0o777) !== 0o700 || realpathSync(root) !== root) fail('EVIDENCE_ROOT_INVALID');
  return root;
}

function registerAttemptNonce(ledgerRoot, { attemptNonce, attemptRoot, releaseId }) {
  if (typeof ledgerRoot !== 'string' || !isAbsolute(ledgerRoot) || resolve(ledgerRoot) !== ledgerRoot
    || !ledgerRoot.startsWith(`${INTERNAL_OUTPUT_ROOT}/`) || dirname(ledgerRoot) !== INTERNAL_OUTPUT_ROOT) {
    fail('ATTEMPT_LEDGER_INVALID');
  }
  try {
    const value = lstatSync(ledgerRoot);
    if (!value.isDirectory() || value.isSymbolicLink() || realpathSync(ledgerRoot) !== ledgerRoot
      || (value.mode & 0o777) !== 0o700 || value.dev !== statSync('/').dev) fail('ATTEMPT_LEDGER_INVALID');
  } catch (error) {
    if (error instanceof AndroidLifecycleRunnerFailure) throw error;
    if (error?.code !== 'ENOENT') fail('ATTEMPT_LEDGER_INVALID');
    mkdirSync(ledgerRoot, { mode: 0o700 });
  }
  if ((statSync(ledgerRoot).mode & 0o777) !== 0o700) fail('ATTEMPT_LEDGER_INVALID');
  const path = join(ledgerRoot, `${attemptNonce.toLowerCase()}.json`);
  writeExclusiveDurable(path, {
    schemaVersion: 'maina.android-lifecycle-attempt-ledger.v1',
    attemptNonce: attemptNonce.toLowerCase(),
    attemptRoot,
    releaseId,
  });
  return fileRecord(path, 'ATTEMPT_LEDGER_INVALID');
}

export function createDurableMutationJournal(attemptRoot) {
  const mutationRoot = join(attemptRoot, 'mutations');
  mkdirSync(mutationRoot, { mode: 0o700 });
  chmodSync(mutationRoot, 0o700);
  const observed = new Map();
  let sequence = 0;
  return async (entry) => {
    if (!exactKeys(entry, ['action', 'attempts', 'id', 'payloadDigest', 'payloadShape', 'state'])
      || typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{2,95}$/u.test(entry.id)
      || !['arm_qualification', 'force_stop', 'launch_main', 'launch_record_qualification', 'press_back', 'press_home', 'sleep_device', 'tap', 'wake_up'].includes(entry.action)
      || !Array.isArray(entry.payloadShape)
      || JSON.stringify(entry.payloadShape) !== JSON.stringify(
        entry.action === 'tap' ? ['x', 'y'] : ['arm_qualification', 'launch_record_qualification'].includes(entry.action) ? ['qualificationRunId'] : [],
      )
      || (['arm_qualification', 'launch_record_qualification'].includes(entry.action)
        ? typeof entry.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.payloadDigest)
        : entry.payloadDigest !== null)
      || entry.attempts !== 1
      || !['issued', 'confirmed_applied', 'confirmed_no_effect', 'ambiguous'].includes(entry.state)) {
      fail('MUTATION_JOURNAL_ENTRY_INVALID');
    }
    const previous = observed.get(entry.id);
    if ((entry.state === 'issued' && previous !== undefined)
      || (entry.state !== 'issued' && (
        previous?.state !== 'issued'
        || previous.action !== entry.action
        || previous.payloadDigest !== entry.payloadDigest
        || JSON.stringify(previous.payloadShape) !== JSON.stringify(entry.payloadShape)
      ))) fail('MUTATION_JOURNAL_TRANSITION_INVALID');
    sequence += 1;
    writeExclusiveDurable(
      join(mutationRoot, `${String(sequence).padStart(3, '0')}-${entry.id}-${entry.state}.json`),
      { schemaVersion: 'maina.android-lifecycle-mutation.v3', sequence, ...entry },
    );
    observed.set(entry.id, Object.freeze({
      action: entry.action,
      payloadDigest: entry.payloadDigest,
      payloadShape: [...entry.payloadShape],
      state: entry.state,
    }));
  };
}

function localMeetingCreatorExclusive() {
  const creators = readdirSync(join(PROJECT_ROOT, 'src/app'), { recursive: true })
    .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !/\.test\.(?:ts|tsx)$/u.test(path))
    .flatMap((path) => {
      const source = readFileSync(join(PROJECT_ROOT, 'src/app', path), 'utf8');
      return (source.match(/\bcreateMeeting\s*\(/gu) ?? []).map(() => path);
    });
  return creators.length === 1 && creators[0] === 'record.tsx';
}

function meetingListNewestFirst() {
  const source = readFileSync(join(PROJECT_ROOT, 'src/data/meetings.ts'), 'utf8');
  return /export async function listMeetings\(\): Promise<Meeting\[\]> \{[\s\S]*?ORDER BY m\.started_at DESC[\s\S]*?\n\}/u.test(source);
}

function runtimeRecords() {
  return [
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaHardwareTrigger.kt',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaQualificationSessionAuthority.kt',
    'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt',
    'scripts/run-android-lifecycle-qualification.mjs',
    'scripts/qualification/android-lifecycle-adapter.mjs',
    'scripts/qualification/android-lifecycle-core.mjs',
    'scripts/qualification/android-lifecycle-scenario.mjs',
    'src/app/record.tsx',
    'src/core/recording/qualificationSession.ts',
    'src/data/meetings.ts',
    'src/hardware/recording/foreground.ts',
    'src/services/remoteLog.ts',
  ].map((relativePath) => {
    const record = fileRecord(join(PROJECT_ROOT, relativePath), 'RUNTIME_FILE_INVALID');
    return Object.freeze({ relativePath, sha256: record.sha256, bytes: record.bytes, mode: record.mode });
  });
}

function mutationJournalRecords(attemptRoot) {
  return readdirSync(join(attemptRoot, 'mutations')).sort().map((name) => {
    const record = fileRecord(join(attemptRoot, 'mutations', name), 'MUTATION_JOURNAL_INVALID');
    return Object.freeze({ name, sha256: record.sha256, bytes: record.bytes, mode: record.mode });
  });
}

export async function runAndroidLifecycleQualification({
  env = process.env,
  run,
  now,
  sleep,
  releaseBinding,
  attemptNonce,
} = {}) {
  if (env.MAINA_ANDROID_LIFECYCLE_QUALIFICATION_RELEASE !== 'approved') fail('LIVE_QUALIFICATION_NOT_RELEASED');
  const injected = run !== undefined || now !== undefined || sleep !== undefined || releaseBinding !== undefined || attemptNonce !== undefined;
  if (injected && env.MAINA_ANDROID_LIFECYCLE_TEST_MODE !== 'approved') fail('TEST_INJECTION_NOT_RELEASED');
  const executionMode = injected ? 'injected_test' : 'native';
  const binding = injected
    ? validateReleaseBindingShape(releaseBinding)
    : loadApprovedAndroidReleaseBinding(env);
  const expectedVersion = binding.expectedVersion;
  const expectedBuild = binding.expectedBuild;
  const adb = env.MAINA_ADB;
  const serial = env.MAINA_ADB_SERIAL;
  if (typeof adb !== 'string' || !isAbsolute(adb) || typeof serial !== 'string'
    || !/^[A-Za-z0-9._:-]{1,255}$/u.test(serial)) fail('DEVICE_BINDING_INVALID');
  if (!injected && adb !== CANONICAL_ADB) fail('ADB_BINARY_INVALID');
  const adbRecord = fileRecord(adb, 'ADB_BINARY_INVALID', { executable: true });
  const adbVersion = injected ? 'injected_test' : canonicalAdbVersion();
  if (!injected && adbRecord.sha256 !== CANONICAL_ADB_SHA256) fail('ADB_BINARY_INVALID');
  const gitRecord = canonicalGitRecord();
  const nodeRecord = fileRecord(process.execPath, 'NODE_BINARY_INVALID', { executable: true });
  if (process.execPath !== binding.node.path || process.versions.node !== binding.node.version
    || nodeRecord.sha256 !== binding.node.sha256) fail('NODE_BINARY_INVALID');
  const clock = now ?? Date.now;
  const startedAtMs = clock();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) fail('CLOCK_INVALID');
  const startedAt = new Date(startedAtMs).toISOString();
  const nonce = attemptNonce ?? randomUUID();
  if (typeof nonce !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce)) {
    fail('ATTEMPT_NONCE_INVALID');
  }

  const attemptRootInput = validateInternalRootPath(env.MAINA_ANDROID_LIFECYCLE_ATTEMPT_ROOT);
  const requestedLedgerRoot = env.MAINA_ANDROID_LIFECYCLE_LEDGER_ROOT;
  if (!injected && requestedLedgerRoot !== undefined && requestedLedgerRoot !== DEFAULT_LEDGER_ROOT) {
    fail('ATTEMPT_LEDGER_INVALID');
  }
  const ledgerRecord = registerAttemptNonce(injected ? (requestedLedgerRoot ?? DEFAULT_LEDGER_ROOT) : DEFAULT_LEDGER_ROOT, {
    attemptNonce: nonce,
    attemptRoot: attemptRootInput,
    releaseId: binding.releaseId,
  });
  const attemptRoot = validateFreshInternalRoot(attemptRootInput);
  const attempt = {
    schemaVersion: 'maina.android-lifecycle-attempt.v2',
    status: 'running',
    startedAt,
    attemptNonce: nonce,
    attemptRoot,
    executionMode,
    releaseId: binding.releaseId,
    expectedVersion,
    expectedBuild,
    plan: binding.plan,
    provenance: binding.provenance,
    artifact: binding.artifact,
    ledger: ledgerRecord,
    source: binding.source,
    node: Object.freeze({
      path: process.execPath,
      sha256: nodeRecord.sha256,
      bytes: nodeRecord.bytes,
      mode: nodeRecord.mode,
      version: process.versions.node,
    }),
    git: gitRecord,
    adb: Object.freeze({ path: adb, sha256: adbRecord.sha256, bytes: adbRecord.bytes, mode: adbRecord.mode, version: adbVersion }),
    serialSha256: sha256Text(serial),
    runtimeFiles: runtimeRecords(),
    rawDeviceOutputPersisted: false,
    physicalIncomingCallTestPerformed: false,
  };
  writeExclusiveDurable(join(attemptRoot, 'attempt.json'), attempt);
  const recordMutationState = createDurableMutationJournal(attemptRoot);
  const tools = createAndroidLifecycleAdbTools({
    adb,
    serial,
    qualificationRunId: nonce,
    run,
    now: clock,
    sleep,
    recordMutationState,
  });
  const result = await executeAndroidLifecycleScenario({
    expectedVersion,
    expectedBuild,
    expectedArtifactSha256: binding.artifact.sha256,
    localMeetingCreatorExclusive: localMeetingCreatorExclusive(),
    meetingListNewestFirst: meetingListNewestFirst(),
    operational: true,
  }, tools);
  if (!exactKeys(result, RESULT_KEYS)) fail('QUALIFICATION_RESULT_INVALID');
  const resultPath = join(attemptRoot, 'result.json');
  writeExclusiveDurable(resultPath, result);
  const terminalName = executionMode === 'injected_test'
    ? 'terminal-test-only.json'
    : result.status === 'passed' ? 'terminal-success.json' : 'terminal-failure.json';
  const completedAtMs = clock();
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < startedAtMs) fail('CLOCK_INVALID');
  writeExclusiveDurable(join(attemptRoot, terminalName), {
    schemaVersion: 'maina.android-lifecycle-terminal.v2',
    status: result.status,
    reasonCode: result.reasonCode,
    reconciliationRequired: result.reconciliationRequired,
    executionMode,
    completedAt: new Date(completedAtMs).toISOString(),
    attemptSha256: sha256File(join(attemptRoot, 'attempt.json')),
    resultSha256: sha256File(resultPath),
    mutationJournal: mutationJournalRecords(attemptRoot),
  });
  return result;
}

async function main() {
  try {
    const result = await runAndroidLifecycleQualification();
    process.stdout.write(`${JSON.stringify({ status: result.status, reasonCode: result.reasonCode })}\n`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch (error) {
    const reasonCode = error instanceof AndroidLifecycleRunnerFailure ? error.code : 'ANDROID_LIFECYCLE_RUNNER_FAILED';
    process.stdout.write(`${JSON.stringify({ status: 'failed_closed', reasonCode })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
