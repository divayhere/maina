#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  evaluatePreflight,
  runReadOnlyObserver,
  runSingleAuthorizedMutation,
} from '../../coordination/scripts/qualification/maina-qualify.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageGuard = '/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh';
const storageGuardSha256 = 'e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f';
const expectedStorageRoot = '/Volumes/DivaySSD/MainaBuild';
const expectedCapabilities = Object.freeze([
  'node',
  'storage_guard',
  'source_revision',
  'clean_worktree',
  'helper_runtime',
  'jdk',
  'android_sdk',
  'gradle',
  'adb_endpoint',
  'android_signing_readiness',
]);

export function collectAndroidPreflight({ env = process.env, run = runCommand } = {}) {
  const results = [];
  const record = (capability, passed, reasonCode) => {
    results.push(passed ? { capability, status: 'PASS' } : { capability, status: 'FAIL', reasonCode });
  };

  const nodeBin = env.MAINA_NODE_BIN ?? '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin';
  const javaHome = env.MAINA_JAVA_HOME ?? `${expectedStorageRoot}/caches/toolchains/maina-build-tools/jdk17/Contents/Home`;
  const androidHome = env.MAINA_ANDROID_HOME ?? env.ANDROID_HOME ?? '/Users/divay/Library/Android/sdk';
  const gradleHome = env.MAINA_GRADLE_HOME ?? `${expectedStorageRoot}/caches/toolchains/maina-build-tools/gradle/gradle-9.3.1`;
  const adb = join(androidHome, 'platform-tools', 'adb');

  const nodeVersion = run(join(nodeBin, 'node'), ['--version']);
  record('node', nodeVersion.ok && /^v24\./.test(nodeVersion.stdout.trim()), 'NODE_24_UNAVAILABLE');

  let guardPass = false;
  try {
    accessSync(storageGuard, constants.X_OK);
    guardPass = sha256File(storageGuard) === storageGuardSha256;
  } catch {
    guardPass = false;
  }
  if (guardPass) {
    const guarded = run(storageGuard, []);
    guardPass = guarded.ok && guarded.stdout === `${expectedStorageRoot}\n`;
  }
  record('storage_guard', guardPass, 'STORAGE_GUARD_REJECTED');

  const head = run('git', ['-C', projectDir, 'rev-parse', 'HEAD']);
  const upstream = run('git', ['-C', projectDir, 'rev-parse', '@{upstream}']);
  const expectedRevision = env.MAINA_EXPECTED_FINAL_COMMIT ?? head.stdout.trim();
  record(
    'source_revision',
    head.ok && upstream.ok && /^[a-f0-9]{40}$/.test(expectedRevision)
      && head.stdout.trim() === expectedRevision && upstream.stdout.trim() === expectedRevision,
    'SOURCE_REVISION_MISMATCH',
  );
  const status = run('git', ['-C', projectDir, 'status', '--porcelain']);
  record('clean_worktree', status.ok && status.stdout === '', 'SOURCE_WORKTREE_DIRTY');

  const helpers = [
    'scripts/m0-replay-harness.sh',
    'scripts/build-android-release-candidate.sh',
    'scripts/install-android-preserving-data.sh',
    'scripts/release-provenance-cli.mjs',
    'release/m3-m4-0.10.51-candidate-plan.json',
  ];
  record('helper_runtime', helpers.every((path) => isReadable(join(projectDir, path))), 'HELPER_RUNTIME_UNAVAILABLE');

  const java = run(join(javaHome, 'bin', 'java'), ['-version']);
  record('jdk', java.ok && /(?:version\s+"17\.|openjdk\s+17\.)/.test(`${java.stdout}\n${java.stderr}`), 'JDK_17_UNAVAILABLE');

  const buildTools = newestBuildTools(androidHome);
  const apksigner = buildTools ? join(androidHome, 'build-tools', buildTools, 'apksigner') : '';
  const aapt = buildTools ? join(androidHome, 'build-tools', buildTools, 'aapt') : '';
  record('android_sdk', isExecutable(adb) && isExecutable(apksigner) && isExecutable(aapt), 'ANDROID_SDK_UNAVAILABLE');

  const gradle = run(join(gradleHome, 'bin', 'gradle'), ['--version']);
  record('gradle', gradle.ok && /^Gradle 9\.3\.1$/m.test(gradle.stdout), 'GRADLE_9_3_1_UNAVAILABLE');

  const endpoint = env.MAINA_ADB_SERIAL ?? 'adb-47011FDAP000VE-9s0wNO._adb-tls-connect._tcp';
  const hardwareSerial = env.MAINA_DEVICE_SERIAL ?? '47011FDAP000VE';
  const devices = run(adb, ['devices']);
  const matching = devices.stdout.split('\n').filter((line) => line.startsWith(`${endpoint}\tdevice`)).length;
  const state = run(adb, ['-s', endpoint, 'get-state']);
  const serial = run(adb, ['-s', endpoint, 'shell', 'getprop', 'ro.serialno']);
  const model = run(adb, ['-s', endpoint, 'shell', 'getprop', 'ro.product.model']);
  record(
    'adb_endpoint',
    endpoint.endsWith('._adb-tls-connect._tcp') && matching === 1 && state.ok
      && state.stdout.trim() === 'device' && serial.ok && serial.stdout.trim() === hardwareSerial
      && model.ok && model.stdout.trim() === 'Pixel 9 Pro',
    'ADB_ENDPOINT_UNAVAILABLE',
  );

  record(
    'android_signing_readiness',
    isReadable(join(projectDir, 'android', 'app', 'debug.keystore')) && isExecutable(apksigner),
    'ANDROID_SIGNING_NOT_READY',
  );

  return Object.freeze(results.map((result) => Object.freeze(result)));
}

export function evaluateAndroidPreflight(results) {
  assert.deepEqual(
    [...results].map(({ capability }) => capability).sort(compareCodeUnits),
    [...expectedCapabilities].sort(compareCodeUnits),
    'ANDROID_PREFLIGHT_CAPABILITY_SET_MISMATCH',
  );
  return evaluatePreflight(loadContract(), 'android', results);
}

function loadContract() {
  return JSON.parse(readFileSync(join(projectDir, 'coordination', 'operations', 'contracts', 'qualification-harness.v1.json'), 'utf8'));
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  return Object.freeze({ ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}

function newestBuildTools(androidHome) {
  try {
    return readdirSync(join(androidHome, 'build-tools')).sort(versionCompare).at(-1) ?? null;
  } catch {
    return null;
  }
}

function isReadable(path) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function versionCompare(left, right) {
  return left.localeCompare(right, 'en', { numeric: true });
}

export async function selfTest() {
  const passResults = expectedCapabilities.map((capability) => ({ capability, status: 'PASS' }));
  assert.equal(evaluateAndroidPreflight(passResults).state, 'PASS');
  const failedResults = passResults.map((result) => result.capability === 'adb_endpoint'
    ? { capability: result.capability, status: 'FAIL', reasonCode: 'ADB_ENDPOINT_UNAVAILABLE' }
    : result);
  assert.deepEqual(evaluateAndroidPreflight(failedResults), {
    state: 'BLOCKED',
    lane: 'android',
    reasonCodes: ['ADB_ENDPOINT_UNAVAILABLE'],
    mutationAttempts: 0,
    reconciliationLock: 'ABSENT',
    evidenceAttemptMarkerCreated: false,
  });

  let observerCalls = 0;
  const observer = await runReadOnlyObserver(async () => {
    observerCalls += 1;
    if (observerCalls < 3) throw Object.assign(new Error('sentinel-private'), { blockerClass: 'TRANSIENT_OBSERVATION' });
    return 'PASS';
  }, { sleep: async () => {} });
  assert.deepEqual({ attempts: observer.attempts, mutationAttempts: observer.mutationAttempts, lock: observer.reconciliationLock }, { attempts: 3, mutationAttempts: 0, lock: 'ABSENT' });

  let mutationCalls = 0;
  let releaseCalls = 0;
  const knownFailure = await runSingleAuthorizedMutation({
    authorization: { isResume: false, freshAuthority: true, inputIdentity: { revision: 'a' }, priorInputIdentity: null, reconciledPriorOutcome: false },
    preflightPassed: true,
    acquireLock: async () => {},
    writeMutationStarted: async () => {},
    mutate: async () => { mutationCalls += 1; throw new Error('sentinel-private'); },
    releaseLock: async () => { releaseCalls += 1; },
    classifyError: () => 'KNOWN_TERMINAL_FAILURE',
  });
  assert.deepEqual({ state: knownFailure.state, attempts: knownFailure.attempts, lock: knownFailure.lock }, { state: 'TERMINAL_FAILURE', attempts: 1, lock: 'RELEASED' });
  assert.equal(mutationCalls, 1);
  assert.equal(releaseCalls, 1);

  releaseCalls = 0;
  const ambiguous = await runSingleAuthorizedMutation({
    authorization: { isResume: false, freshAuthority: true, inputIdentity: { revision: 'a' }, priorInputIdentity: null, reconciledPriorOutcome: false },
    preflightPassed: true,
    acquireLock: async () => {},
    writeMutationStarted: async () => {},
    mutate: async () => { throw new Error('sentinel-private'); },
    releaseLock: async () => { releaseCalls += 1; },
    classifyError: () => 'AMBIGUOUS_MUTATION',
  });
  assert.deepEqual({ state: ambiguous.state, attempts: ambiguous.attempts, lock: ambiguous.lock }, { state: 'RECONCILING', attempts: 1, lock: 'RETAINED' });
  assert.equal(releaseCalls, 0);

  const source = (path) => readFileSync(join(projectDir, path), 'utf8');
  const build = source('scripts/build-android-release-candidate.sh');
  assert.ok(build.indexOf('android-lane.mjs" preflight') < build.indexOf(': > "$OUTPUT_DIR/build-attempted"'));
  assert.ok(build.indexOf('verify-build-source-state.mjs android') < build.indexOf(': > "$OUTPUT_DIR/build-attempted"'));
  const installer = source('scripts/install-android-preserving-data.sh');
  assert.ok(installer.indexOf('inspect_installed "$RUN_DIR/installed-before.apk"') < installer.indexOf('mkdir "$LOCK_DIR"'));
  assert.ok(installer.indexOf('if [[ "$MODE" == "--dry-run" ]]') < installer.indexOf('mkdir "$LOCK_DIR"'));
  assert.match(installer, /write_lock_state "mutation_started"/);
  assert.doesNotMatch(installer, /source "\$PROJECT_DIR\/scripts\/maina-env\.sh"/);
  const replay = source('scripts/m0-replay-harness.sh');
  assert.match(replay, /LANE="\$\{1:-\}"/);
  assert.match(replay, /case "\$LANE" in/);
  assert.match(replay, /CURRENT_FILE="\$ROOT\/current-\$LANE"/);
  assert.doesNotMatch(replay, /--noredact|screencap|developer dvt screenshot/);
  assert.doesNotMatch(replay, /\blogcat\b|syslog live|android-audio\.txt|android-notifications\.txt|ios-processes\.txt/);
  assert.doesNotMatch(replay, /android_serial=%s|ios_udid=%s|ios_coredevice_id=%s/);
  syntheticReplayTest();

  console.log('Android qualification adapter self-tests passed (preflight 2, observer 1, mutation 2, script boundaries 12, replay 1).');
}

function syntheticReplayTest() {
  const root = mkdtempSync(join(tmpdir(), 'maina-android-lane-'));
  const bin = join(root, 'bin');
  const evidence = join(root, 'evidence');
  mkdirSync(bin);
  const fakeNode = join(bin, 'node');
  const fakeAdb = join(bin, 'adb');
  writeExecutable(fakeNode, `#!/usr/bin/env bash
set -euo pipefail
[[ "\${2:-}" == "replay-config" ]] || exit 97
printf 'com.divay.maina\\t0.10.51\\t77\\tcom.divay.maina.staging\\t0.10.51\\t77\\n'
`);
  writeExecutable(fakeAdb, `#!/usr/bin/env bash
set -euo pipefail
endpoint="\${MAINA_ANDROID_SERIAL:?}"
if [[ "\${1:-}" == "devices" ]]; then
  printf 'List of devices attached\\n%s\\tdevice\\n' "$endpoint"
  exit 0
fi
[[ "\${1:-}" == "-s" && "\${2:-}" == "$endpoint" ]] || exit 91
shift 2
case "\${1:-}:\${2:-}:\${3:-}" in
  get-state::) printf 'device\\n' ;;
  shell:getprop:ro.serialno) printf '47011FDAP000VE\\n' ;;
  shell:getprop:ro.product.model) printf 'Pixel 9 Pro\\n' ;;
  shell:dumpsys:package) printf 'versionName=0.10.51\\nversionCode=77 minSdk=24\\n' ;;
  shell:pidof:com.divay.maina) printf 'PRIVATE-SENTINEL-PID\\n' ;;
  shell:dumpsys:audio|shell:dumpsys:notification) printf 'PRIVATE-SENTINEL-CONTENT\\n' ;;
  *) exit 92 ;;
esac
`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MAINA_ANDROID_SERIAL: 'adb-47011FDAP000VE-test._adb-tls-connect._tcp',
    MAINA_M0_EVIDENCE_ROOT: evidence,
    MAINA_RELEASE_PROVENANCE: join(root, 'synthetic-provenance.json'),
  };
  const harness = join(projectDir, 'scripts', 'm0-replay-harness.sh');
  try {
    runSyntheticHarness(harness, ['android', 'arm', 'test3-call-interruption'], env);
    runSyntheticHarness(harness, ['android', 'health'], env);
    runSyntheticHarness(harness, ['android', 'snapshot', 'manual'], env);
    runSyntheticHarness(harness, ['android', 'stop'], env);
    const evidenceText = readdirSync(evidence, { recursive: true })
      .map((path) => join(evidence, path))
      .filter((path) => {
        try { return !readFileSync(path).equals(Buffer.alloc(0)); } catch { return false; }
      })
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    assert.doesNotMatch(evidenceText, /PRIVATE-SENTINEL|47011FDAP000VE|\/var\/folders|\/Users\//);
    assert.match(evidenceText, /maina\.m0-sanitized-snapshot\.v1/);
    assert.match(evidenceText, /observer_status=PASS/);
  } finally {
    const current = join(evidence, 'current-android');
    if (existsSync(current)) {
      const runId = readFileSync(current, 'utf8').trim();
      const pidFile = join(evidence, runId, 'android-observer.pid');
      if (existsSync(pidFile)) {
        try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGTERM'); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function runSyntheticHarness(harness, args, env) {
  const result = spawnSync('bash', [harness, ...args], { cwd: projectDir, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, `SYNTHETIC_REPLAY_FAILED:${args[1]}:${result.stderr}`);
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  if (process.argv[2] !== 'preflight') throw new Error('Usage: android-lane.mjs preflight | --self-test');
  const results = collectAndroidPreflight();
  const evaluation = evaluateAndroidPreflight(results);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'maina.android-qualification-preflight.v1', lane: 'android', status: evaluation.state, results })}\n`);
  if (evaluation.state !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(/^[A-Z][A-Z0-9_]{2,127}$/.test(error.message) ? error.message : 'ANDROID_QUALIFICATION_ADAPTER_FAILED');
    process.exitCode = 2;
  });
}
