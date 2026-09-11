#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants as fsConstants, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [serial, apiText, mainaApkArg, expectedMainaApkSha256, evidenceRootArg] = process.argv.slice(2);
const expectedApi = Number(apiText);
const mainaApk = resolve(mainaApkArg ?? '');
const evidenceRoot = resolve(evidenceRootArg ?? '');
const externalRoot = '/Volumes/DivaySSD/MainaBuild/';
const sdkRoot = '/Volumes/DivaySSD/MainaBuild/caches/android/s2-hostile-emulator-20260910/sdk';
const buildTools = '/Users/divay/Library/Android/sdk/build-tools/36.0.0';
const javaHome = '/Volumes/DivaySSD/MainaBuild/caches/toolchains/maina-build-tools/jdk17/Contents/Home';
const androidJar = '/Users/divay/Library/Android/sdk/platforms/android-36/android.jar';
const adb = join(sdkRoot, 'platform-tools/adb');
const javaEnv = { ...process.env, JAVA_HOME: javaHome };
const mainaPackage = 'com.divay.maina';
const hostilePackage = 'com.divay.maina.hostile';
const resultPath = join(evidenceRoot, 'result.json');
const hostileIdleStabilityMs = 30_000;

function fail(code) {
  throw new Error(code);
}

function requireRegular(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('INPUT_NOT_REGULAR');
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function run(path, args, options = {}) {
  const result = spawnSync(path, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function must(path, args, code, options) {
  const result = run(path, args, options);
  if (result.error || result.signal || result.status !== 0) fail(code);
  return result.stdout;
}

function adbRun(args, code, timeout) {
  return must(adb, ['-s', serial, ...args], code, { timeout });
}

function waitForBroadcastIdle() {
  adbRun(['shell', 'am', 'wait-for-broadcast-idle'], 'BROADCAST_IDLE_BARRIER_FAILED', 120_000);
}

function notificationState() {
  const dump = adbRun(['shell', 'dumpsys', 'notification', '--noredact'], 'NOTIFICATION_QUERY_FAILED');
  const titles = [...dump.matchAll(/android\.title=String \((Maina is ready|Maina is recording|Maina is paused|Maina is saving)\)/g)]
    .map((match) => match[1]);
  const unique = [...new Set(titles)];
  if (unique.length !== 1) return 'unknown';
  return new Map([
    ['Maina is ready', 'idle'],
    ['Maina is recording', 'recording'],
    ['Maina is paused', 'paused'],
    ['Maina is saving', 'finalizing'],
  ]).get(unique[0]) ?? 'unknown';
}

function waitForState(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (notificationState() === expected) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  } while (Date.now() < deadline);
  return false;
}

function requireStableState(expected, durationMs) {
  const deadline = Date.now() + durationMs;
  do {
    if (notificationState() !== expected) fail('HOSTILE_STATE_MUTATION');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  } while (Date.now() < deadline);
}

function buildHostile(workRoot) {
  const classes = join(workRoot, 'classes');
  const dex = join(workRoot, 'dex');
  mkdirSync(classes, { mode: 0o700 });
  mkdirSync(dex, { mode: 0o700 });
  const fixtureRoot = join(repoRoot, 'scripts/fixtures/android-command-hostile');
  const manifest = join(fixtureRoot, 'AndroidManifest.xml');
  const source = join(fixtureRoot, 'HostileReceiver.java');
  requireRegular(manifest);
  requireRegular(source);
  must(join(javaHome, 'bin/javac'), ['-source', '8', '-target', '8', '-classpath', androidJar, '-d', classes, source], 'HOSTILE_JAVA_COMPILE_FAILED');
  const classFile = join(classes, 'com/divay/maina/hostile/HostileReceiver.class');
  requireRegular(classFile);
  const classJar = join(workRoot, 'hostile-classes.jar');
  must(join(javaHome, 'bin/jar'), ['cf', classJar, '-C', classes, '.'], 'HOSTILE_JAR_FAILED');
  must(join(buildTools, 'd8'), ['--lib', androidJar, '--min-api', '24', '--output', dex, classJar], 'HOSTILE_DEX_FAILED', { env: javaEnv });
  const unsignedApk = join(workRoot, 'hostile-unsigned.apk');
  must(join(buildTools, 'aapt2'), ['link', '-o', unsignedApk, '--manifest', manifest, '-I', androidJar, '--min-sdk-version', '24', '--target-sdk-version', '36'], 'HOSTILE_LINK_FAILED');
  must('/usr/bin/zip', ['-q', '-j', unsignedApk, join(dex, 'classes.dex')], 'HOSTILE_DEX_PACKAGE_FAILED');
  const keyStore = join(workRoot, 'hostile.jks');
  must(join(javaHome, 'bin/keytool'), ['-genkeypair', '-keystore', keyStore, '-storepass', 'changeit', '-keypass', 'changeit', '-alias', 'hostile', '-dname', 'CN=MainaHostileProbe', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-noprompt'], 'HOSTILE_KEY_FAILED');
  const signedApk = join(workRoot, 'hostile.apk');
  must(join(buildTools, 'apksigner'), ['sign', '--ks', keyStore, '--ks-pass', 'pass:changeit', '--key-pass', 'pass:changeit', '--out', signedApk, unsignedApk], 'HOSTILE_SIGN_FAILED', { env: javaEnv });
  must(join(buildTools, 'apksigner'), ['verify', '--verbose', signedApk], 'HOSTILE_SIGNATURE_INVALID', { env: javaEnv });
  return signedApk;
}

function helperAttack(mode) {
  adbRun(['shell', 'run-as', hostilePackage, 'rm', '-f', 'files/result.txt'], 'HOSTILE_RESULT_RESET_FAILED');
  adbRun(['shell', 'am', 'broadcast', '-n', `${hostilePackage}/.HostileReceiver`, '-a', 'com.divay.maina.hostile.ATTACK', '--es', 'mode', mode], 'HOSTILE_TRIGGER_FAILED');
  const deadline = Date.now() + 5_000;
  do {
    const read = run(adb, ['-s', serial, 'shell', 'run-as', hostilePackage, 'cat', 'files/result.txt'], { timeout: 5_000 });
    const value = read.status === 0 ? read.stdout.trim() : '';
    if (['sent', 'security_exception'].includes(value) || /^ordered_result_-?[0-9]+$/.test(value)) return value;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  } while (Date.now() < deadline);
  fail('HOSTILE_RESULT_MISSING');
}

function shellCommand(command, expectedState, nonce, extra = false) {
  const args = [
    'shell', 'am', 'broadcast',
    '-n', `${mainaPackage}/com.divay.maina.recorder.MainaShellCommandReceiver`,
    '-a', 'com.divay.maina.recorder.SHELL_COMMAND',
    '--es', 'command', command,
    '--es', 'expectedState', expectedState,
    '--es', 'nonce', nonce,
  ];
  if (extra) args.push('--es', 'unexpected', 'blocked');
  return adbRun(args, 'SHELL_COMMAND_FAILED');
}

let result = {
  schemaVersion: '2',
  status: 'failed_closed',
  reasonCode: 'UNINITIALIZED',
  apiLevel: Number.isSafeInteger(expectedApi) ? expectedApi : null,
  emulatorVerified: false,
  mainaApkSha256: null,
  mainaApkStagedPrivate: false,
  mainaIdentityVerified: false,
  signerSeparationVerified: false,
  hostileAttempts: 0,
  broadcastIdleBarriers: 0,
  hostileStateChanges: 0,
  hostileIdleStabilityMs,
  preShellIdleStabilityMs: 0,
  hostileDumpBoundaryRejected: false,
  shellAcceptedTransitions: 0,
  replayRejected: false,
  unknownExtraRejected: false,
  physicalDeviceCommandsExecuted: 0,
};

let workRoot = null;
try {
  if (!/^emulator-[0-9]+$/.test(serial ?? '') || ![32, 36].includes(expectedApi)) fail('ARGUMENT_INVALID');
  if (!/^[a-f0-9]{64}$/.test(expectedMainaApkSha256 ?? '')) fail('ARGUMENT_INVALID');
  if (!evidenceRoot.startsWith(externalRoot)) fail('EVIDENCE_ROOT_NOT_EXTERNAL');
  if (statSync(dirname(evidenceRoot)).dev === statSync('/').dev) fail('EVIDENCE_DEVICE_INVALID');
  requireRegular(mainaApk);
  mkdirSync(evidenceRoot, { mode: 0o700 });
  chmodSync(evidenceRoot, 0o700);
  if (realpathSync(evidenceRoot) !== evidenceRoot) fail('EVIDENCE_ROOT_INVALID');
  workRoot = mkdtempSync(join(evidenceRoot, '.work-'));
  chmodSync(workRoot, 0o700);
  const stagedMainaApk = join(workRoot, 'maina.apk');
  copyFileSync(mainaApk, stagedMainaApk, fsConstants.COPYFILE_EXCL);
  chmodSync(stagedMainaApk, 0o600);
  requireRegular(stagedMainaApk);
  const actualMainaApkSha256 = await sha256File(stagedMainaApk);
  if (actualMainaApkSha256 !== expectedMainaApkSha256) fail('MAINA_APK_SHA256_MISMATCH');
  result.mainaApkSha256 = actualMainaApkSha256;
  result.mainaApkStagedPrivate = true;

  const qemu = adbRun(['shell', 'getprop', 'ro.kernel.qemu'], 'EMULATOR_IDENTITY_FAILED').trim();
  const api = Number(adbRun(['shell', 'getprop', 'ro.build.version.sdk'], 'EMULATOR_API_FAILED').trim());
  if (qemu !== '1' || api !== expectedApi) fail('EMULATOR_IDENTITY_MISMATCH');
  result.emulatorVerified = true;

  const badging = must(join(buildTools, 'aapt2'), ['dump', 'badging', stagedMainaApk], 'MAINA_APK_INSPECTION_FAILED');
  if (!badging.includes("package: name='com.divay.maina' versionCode='95' versionName='0.10.69'")) fail('MAINA_APK_IDENTITY_MISMATCH');
  result.mainaIdentityVerified = true;

  const hostileApk = buildHostile(workRoot);
  const mainaCert = must(join(buildTools, 'apksigner'), ['verify', '--print-certs', stagedMainaApk], 'MAINA_SIGNATURE_INVALID', { env: javaEnv });
  const hostileCert = must(join(buildTools, 'apksigner'), ['verify', '--print-certs', hostileApk], 'HOSTILE_SIGNATURE_INVALID', { env: javaEnv });
  if (mainaCert === hostileCert) fail('SIGNER_SEPARATION_FAILED');
  result.signerSeparationVerified = true;

  run(adb, ['-s', serial, 'uninstall', hostilePackage]);
  run(adb, ['-s', serial, 'uninstall', mainaPackage]);
  adbRun(['install', '-r', stagedMainaApk], 'MAINA_INSTALL_FAILED', 180_000);
  adbRun(['install', '-r', hostileApk], 'HOSTILE_INSTALL_FAILED', 60_000);
  adbRun(['shell', 'pm', 'grant', mainaPackage, 'android.permission.RECORD_AUDIO'], 'MIC_PERMISSION_FAILED');
  if (expectedApi >= 33) adbRun(['shell', 'pm', 'grant', mainaPackage, 'android.permission.POST_NOTIFICATIONS'], 'NOTIFICATION_PERMISSION_FAILED');
  adbRun(['shell', 'am', 'start', '-W', '-n', `${mainaPackage}/.MainActivity`], 'MAINA_LAUNCH_FAILED');
  if (!waitForState('idle', 60_000)) fail('MAINA_READY_TIMEOUT');

  const modes = ['static_explicit', 'static_package', 'dynamic_exact', 'shell_explicit'];
  for (const mode of modes) {
    if (notificationState() !== 'idle') fail('HOSTILE_PRESTATE_INVALID');
    const outcome = helperAttack(mode);
    result.hostileAttempts += 1;
    if (mode === 'shell_explicit') {
      result.hostileDumpBoundaryRejected = outcome === 'security_exception' || outcome === 'ordered_result_0';
      if (!result.hostileDumpBoundaryRejected) fail('HOSTILE_DUMP_BOUNDARY_FAILED');
    }
    waitForBroadcastIdle();
    result.broadcastIdleBarriers += 1;
    try {
      requireStableState('idle', hostileIdleStabilityMs);
    } catch (cause) {
      result.hostileStateChanges += 1;
      throw cause;
    }
  }

  waitForBroadcastIdle();
  result.broadcastIdleBarriers += 1;
  requireStableState('idle', hostileIdleStabilityMs);
  result.preShellIdleStabilityMs = hostileIdleStabilityMs;

  const startNonce = randomUUID().replaceAll('-', '');
  const startOutput = shellCommand('start', 'idle', startNonce);
  if (!startOutput.includes('result=17051') || !startOutput.includes(`data="${startNonce}"`)) fail('SHELL_ACK_MISSING');
  if (!waitForState('recording', 30_000)) fail('SHELL_TRANSITION_TIMEOUT');
  result.shellAcceptedTransitions = 1;

  const replayOutput = shellCommand('pause', 'recording', startNonce);
  result.replayRejected = !replayOutput.includes('result=17051');
  if (!result.replayRejected || notificationState() !== 'recording') fail('SHELL_REPLAY_ACCEPTED');

  const extraOutput = shellCommand('pause', 'recording', randomUUID().replaceAll('-', ''), true);
  result.unknownExtraRejected = !extraOutput.includes('result=17051');
  if (!result.unknownExtraRejected || notificationState() !== 'recording') fail('SHELL_EXTRA_ACCEPTED');

  result.status = 'passed';
  result.reasonCode = 'PASS';
} catch (cause) {
  result.reasonCode = cause instanceof Error && /^[A-Z0-9_]+$/.test(cause.message) ? cause.message : 'UNEXPECTED_FAILURE';
} finally {
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
  if (evidenceRoot.startsWith(externalRoot)) {
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    chmodSync(resultPath, 0o600);
  }
  if (result.emulatorVerified) {
    run(adb, ['-s', serial, 'uninstall', hostilePackage]);
    run(adb, ['-s', serial, 'uninstall', mainaPackage]);
  }
}

if (result.status !== 'passed') process.exitCode = 1;
else process.stdout.write(`Android command-surface emulator verification passed on API ${expectedApi}.\n`);
