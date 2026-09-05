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
    printf 'install\\n' >> "$state/install-count"
    : > "$state/install-started"
    while [[ ! -f "$state/release-install" ]]; do sleep 0.02; done
    cp "$3" "$state/installed.apk"
    printf '76' > "$state/version-code"
    printf '0.10.50' > "$state/version-name"
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
printf "package: name='com.divay.maina' versionCode='76' versionName='0.10.50' platformBuildVersionName=''\\n"
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
    writeFileSync(join(state, 'version-code'), '76');
    writeFileSync(join(state, 'version-name'), '0.10.50');
  } else {
    writeFileSync(join(state, 'installed.apk'), 'previous-installed-apk');
    writeFileSync(join(state, 'version-code'), '67');
    writeFileSync(join(state, 'version-name'), '0.10.41');
  }
}

function spawnInstaller() {
  const child = spawn('bash', [installer, candidate], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.sanitizedStderr = '';
  child.stderr.on('data', (chunk) => { child.sanitizedStderr += chunk; });
  return child;
}

function waitFor(path, timeoutMs = 3_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(path)) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${path}`));
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

try {
  resetInstalled();
  const first = spawnInstaller();
  const firstExit = waitForExit(first);
  await waitFor(join(state, 'install-started')).catch((error) => {
    first.kill('SIGTERM');
    throw new Error(`${error.message}; installer stderr: ${first.sanitizedStderr}`);
  });
  const activeState = readFileSync(join(lockDirectory, 'state'), 'utf8');
  assert.match(activeState, /candidate_sha256=[a-f0-9]{64}/);
  assert.match(activeState, /outcome=running/);
  const second = spawnSync('bash', [installer, candidate], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(second.status, 75);
  assert.match(second.stderr, /running or has an unknown outcome/);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);
  writeFileSync(join(state, 'release-install'), 'release');
  assert.deepEqual(await firstExit, { code: 0, signal: null });
  assert.equal(existsSync(lockDirectory), false);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);

  resetInstalled();
  const interrupted = spawnInstaller();
  const interruptedExit = waitForExit(interrupted);
  await waitFor(join(state, 'install-started')).catch((error) => {
    interrupted.kill('SIGTERM');
    throw new Error(`${error.message}; installer stderr: ${interrupted.sanitizedStderr}`);
  });
  interrupted.kill('SIGTERM');
  writeFileSync(join(state, 'release-install'), 'release');
  const interruptedResult = await interruptedExit;
  assert.notEqual(interruptedResult.code, 0);
  const retainedLock = join(lockDirectory, 'state');
  assert.equal(existsSync(retainedLock), true);
  assert.match(readFileSync(retainedLock, 'utf8'), /outcome=reconciliation_required/);
  const refused = spawnSync('bash', [installer, candidate], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(refused.status, 75);
  assert.equal(readFileSync(join(state, 'install-count'), 'utf8').trim().split('\n').length, 1);

  resetInstalled({ identical: true });
  const alreadyInstalled = spawnSync('bash', [installer, candidate], { cwd: repoRoot, env, encoding: 'utf8' });
  assert.equal(alreadyInstalled.status, 0, alreadyInstalled.stderr);
  assert.match(alreadyInstalled.stdout, /already installed/);
  assert.equal(existsSync(join(state, 'install-count')), false);
  assert.equal(existsSync(lockDirectory), false);

  console.log('Android installer single-flight policy verified.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
