import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(repoRoot, 'scripts/install-android-preserving-data.sh');
const root = mkdtempSync(join(tmpdir(), 'maina-install-single-flight-'));
const androidHome = join(root, 'android-sdk');
const tools = join(androidHome, 'build-tools', '99.0.0');
const state = join(root, 'state');
const locks = join(root, 'locks');
const fakeJdk = join(root, 'jdk');
const fakeNodeBin = join(root, 'node-bin');
const candidate = join(root, 'candidate.apk');
const endpoint = 'adb-47011FDAP000VE-test._adb-tls-connect._tcp';
const deviceSerial = '47011FDAP000VE';
const packageName = 'com.divay.maina';
const lockDirectory = join(locks, `${deviceSerial}--${packageName}`);
const activeChildren = new Set();

mkdirSync(join(androidHome, 'platform-tools'), { recursive: true });
mkdirSync(tools, { recursive: true });
mkdirSync(state, { recursive: true });
mkdirSync(join(fakeJdk, 'bin'), { recursive: true });
mkdirSync(fakeNodeBin, { recursive: true });
writeFileSync(join(fakeJdk, 'bin', 'java'), '#!/usr/bin/env bash\nexit 0\n');
chmodSync(join(fakeJdk, 'bin', 'java'), 0o755);
writeFileSync(join(fakeNodeBin, 'node'), `#!/usr/bin/env bash
if [[ "\${1:-}" == *"/scripts/release-provenance-cli.mjs" && "\${2:-}" == "authorize" ]]; then
  exit 0
fi
exec "${process.execPath}" "$@"
`);
chmodSync(join(fakeNodeBin, 'node'), 0o755);
writeFileSync(candidate, 'approved-candidate-apk');

const adb = join(androidHome, 'platform-tools', 'adb');
writeFileSync(adb, `#!/usr/bin/env bash
set -euo pipefail
state="\${FAKE_INSTALL_STATE:?}"
endpoint="\${MAINA_ADB_SERIAL:?}"
if [[ "\${1:-}" == "devices" ]]; then
  [[ "\${FAKE_INSTALL_EARLY_EXIT:-0}" != "1" ]] || exit 93
  printf 'List of devices attached\\n%s device product:komodo model:Pixel_9_Pro transport_id:1\\n' "$endpoint"
  exit 0
fi
[[ "\${1:-}" == "-s" && "\${2:-}" == "$endpoint" ]] || exit 91
shift 2
case "\${1:-}:\${2:-}:\${3:-}" in
  shell:getprop:ro.serialno) printf '47011FDAP000VE\\n' ;;
  shell:getprop:ro.product.model) printf 'Pixel 9 Pro\\n' ;;
  shell:pm:list) printf 'package:com.divay.maina\\n' ;;
  shell:pm:path) printf 'package:/data/app/com.divay.maina/base.apk\\n' ;;
  shell:dumpsys:package)
    printf '  versionCode=%s minSdk=24 targetSdk=36\\n' "$(<"$state/version-code")"
    printf '  versionName=%s\\n' "$(<"$state/version-name")"
    ;;
  pull:/data/app/com.divay.maina/base.apk:*)
    cp "$state/installed.apk" "$3"
    ;;
  install:-r:*)
    [[ "\${FAKE_INSTALL_PRE_MARKER_DELAY_SECONDS:-0}" == "0" ]] \\
      || sleep "\${FAKE_INSTALL_PRE_MARKER_DELAY_SECONDS}"
    printf 'install\\n' >> "$state/install-count"
    : > "$state/install-started"
    while [[ ! -f "$state/release-install" ]]; do sleep 0.02; done
    cp "$3" "$state/installed.apk"
    printf '97' > "$state/version-code"
    printf '0.10.71' > "$state/version-name"
    printf 'Performing Streamed Install\\nSuccess\\n'
    ;;
  *)
    printf 'unexpected fake adb command: %s\\n' "$*" >&2
    exit 92
    ;;
esac
`);
chmodSync(adb, 0o755);

const apksigner = join(tools, 'apksigner');
writeFileSync(apksigner, `#!/usr/bin/env bash
printf 'Signer #1 certificate SHA-256 digest: signer-sha\\n'
`);
chmodSync(apksigner, 0o755);

const aapt = join(tools, 'aapt');
writeFileSync(aapt, `#!/usr/bin/env bash
printf "package: name='com.divay.maina' versionCode='97' versionName='0.10.71' platformBuildVersionName=''\\n"
`);
chmodSync(aapt, 0o755);

const env = {
  ...process.env,
  MAINA_ANDROID_HOME: androidHome,
  ANDROID_HOME: androidHome,
  MAINA_NODE_BIN: fakeNodeBin,
  MAINA_JAVA_HOME: fakeJdk,
  MAINA_ADB_SERIAL: endpoint,
  MAINA_DEVICE_SERIAL: deviceSerial,
  MAINA_ANDROID_PACKAGE: packageName,
  MAINA_INSTALL_LOCK_ROOT: locks,
  MAINA_RELEASE_PROVENANCE: join(root, 'approved-provenance.json'),
  FAKE_INSTALL_STATE: state,
};

function resetInstalled({ identical = false } = {}) {
  rmSync(locks, { recursive: true, force: true });
  for (const name of ['install-count', 'install-started', 'release-install']) {
    rmSync(join(state, name), { force: true });
  }
  if (identical) {
    copyFileSync(candidate, join(state, 'installed.apk'));
    writeFileSync(join(state, 'version-code'), '97');
    writeFileSync(join(state, 'version-name'), '0.10.71');
  } else {
    writeFileSync(join(state, 'installed.apk'), 'previous-installed-apk');
    writeFileSync(join(state, 'version-code'), '67');
    writeFileSync(join(state, 'version-name'), '0.10.41');
  }
}

function spawnInstaller(extraEnv = {}) {
  const child = spawn('bash', [installer, candidate], {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  activeChildren.add(child);
  child.errorPromise = new Promise((resolve) => {
    child.on('error', () => resolve());
  });
  child.closePromise = new Promise((resolve) => child.once('close', (code, signal) => {
    activeChildren.delete(child);
    resolve({ code, signal });
  }));
  child.sanitizedStderr = '';
  child.stderr.on('data', (chunk) => { child.sanitizedStderr += chunk; });
  return child;
}

function spawnInstallerSync(extraEnv = {}) {
  return spawnSync('bash', [installer, candidate], {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
}

function waitForMarkerOrExit(child, path, timeoutMs = 15_000) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    child.errorPromise.then(() => finish(reject, new Error('INSTALLER_CHILD_SPAWN_FAILED')));
    child.closePromise.then(({ code, signal }) => {
      if (existsSync(path)) finish(resolve);
      else finish(reject, new Error(`INSTALLER_CHILD_EXITED_BEFORE_MARKER:exit=${code ?? 'null'}:signal=${signal ?? 'null'}`));
    });
    const check = () => {
      if (existsSync(path)) return finish(resolve);
      if (performance.now() - started >= timeoutMs) {
        return finish(reject, new Error('INSTALLER_MARKER_TIMEOUT'));
      }
      timer = setTimeout(check, 10);
    };
    check();
  });
}

function waitForExit(child) {
  return child.closePromise;
}

function waitForCloseWithDeadline(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ state: 'timeout' });
    }, timeoutMs);
    child.closePromise.then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ state: 'closed', result });
    });
  });
}

async function stopChild(child) {
  writeFileSync(join(state, 'release-install'), 'release');
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const graceful = await waitForCloseWithDeadline(child, 2_000);
  if (graceful.state === 'closed') return graceful.result;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  const forced = await waitForCloseWithDeadline(child, 2_000);
  if (forced.state !== 'closed') throw new Error('INSTALLER_CHILD_CLEANUP_TIMEOUT');
  return forced.result;
}

async function awaitChildCloseBounded(child, timeoutCode, timeoutMs = 5_000) {
  const completion = await waitForCloseWithDeadline(child, timeoutMs);
  if (completion.state === 'closed') return completion.result;
  await stopChild(child);
  throw new Error(timeoutCode);
}

async function stopAllChildren() {
  const children = [...activeChildren];
  if (children.length === 0) return;
  await Promise.all(children.map((child) => stopChild(child)));
}

try {
  resetInstalled();
  const earlyExit = spawnInstaller({ FAKE_INSTALL_EARLY_EXIT: '1' });
  const earlyExitResult = waitForExit(earlyExit);
  await assert.rejects(
    waitForMarkerOrExit(earlyExit, join(state, 'install-started')),
    /INSTALLER_CHILD_EXITED_BEFORE_MARKER:exit=93:signal=null/,
  );
  assert.deepEqual(await earlyExitResult, { code: 93, signal: null });

  resetInstalled();
  const first = spawnInstaller({ FAKE_INSTALL_PRE_MARKER_DELAY_SECONDS: '3.2' });
  try {
    await waitForMarkerOrExit(first, join(state, 'install-started'));
  } catch (error) {
    const exit = await stopChild(first);
    throw new Error(`${error.message}; exit=${exit.code}; signal=${exit.signal}; installer stderr: ${first.sanitizedStderr}`);
  }
  const activeState = readFileSync(join(lockDirectory, 'state'), 'utf8');
  assert.match(activeState, /candidate_sha256=[a-f0-9]{64}/);
  assert.match(activeState, /outcome=running/);
  const second = spawnInstallerSync();
  assert.equal(second.status, 75);
  assert.match(second.stderr, /running or has an unknown outcome/);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);
  writeFileSync(join(state, 'release-install'), 'release');
  assert.deepEqual(await awaitChildCloseBounded(first, 'INSTALLER_CHILD_COMPLETION_TIMEOUT'), { code: 0, signal: null });
  assert.equal(existsSync(lockDirectory), false);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);

  resetInstalled();
  const interrupted = spawnInstaller();
  try {
    await waitForMarkerOrExit(interrupted, join(state, 'install-started'));
  } catch (error) {
    const exit = await stopChild(interrupted);
    throw new Error(`${error.message}; exit=${exit.code}; signal=${exit.signal}; installer stderr: ${interrupted.sanitizedStderr}`);
  }
  interrupted.kill('SIGTERM');
  writeFileSync(join(state, 'release-install'), 'release');
  const interruptedResult = await awaitChildCloseBounded(interrupted, 'INSTALLER_CHILD_INTERRUPTION_TIMEOUT');
  assert.notEqual(interruptedResult.code, 0);
  const retainedLock = join(lockDirectory, 'state');
  assert.equal(existsSync(retainedLock), true);
  assert.match(readFileSync(retainedLock, 'utf8'), /outcome=reconciliation_required/);
  const refused = spawnInstallerSync();
  assert.equal(refused.status, 75);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);

  resetInstalled({ identical: true });
  const alreadyInstalled = spawnInstallerSync();
  assert.equal(alreadyInstalled.status, 0, alreadyInstalled.stderr);
  assert.match(alreadyInstalled.stdout, /already installed/);
  assert.equal(existsSync(join(state, 'install-count')), false);
  assert.equal(existsSync(lockDirectory), false);

  console.log('Android installer single-flight policy verified.');
} finally {
  await stopAllChildren();
  rmSync(root, { recursive: true, force: true });
}
