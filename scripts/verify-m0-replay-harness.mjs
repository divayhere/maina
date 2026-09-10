#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harnessPath = path.join(repoRoot, 'scripts', 'm0-replay-harness.sh');
const source = readFileSync(harnessPath, 'utf8');

execFileSync('/bin/bash', ['-n', harnessPath], { stdio: 'inherit' });

const requiredFragments = [
  '._adb-tls-connect._tcp',
  'getprop ro.serialno',
  'getprop ro.product.model',
  'active_run_exists',
  'Refusing to arm over an active replay',
  'kill -0 "$pid"',
  'test -s "$log_file"',
  'sample_age <= 45',
  'ios_runtime_identity_probe',
  'maina-m0-ios-runtime.XXXXXX',
  'trap \'rm -R -- "$run_root"\' EXIT',
  "trap 'exit 130' HUP INT TERM",
  'maina.ios-coredevice-capability-proof.v1',
  'findQualifiedIosDevice',
  'findInstalledIosApp',
  'validateInstalledIosArtifact',
  'M0_IOS_CAPABILITY_PROOF_FAILED',
  'M0_IOS_DEVICE_LIST_FAILED',
  'M0_IOS_APP_QUERY_FAILED',
  'M0_IOS_IDENTITY_REJECTED',
  'release-provenance-cli.mjs" replay-config',
  'PROVENANCE_ANDROID_VERSION',
  'PROVENANCE_IOS_VERSION',
  'health)',
  'LANE="${1:-}"',
  'CURRENT_FILE="$ROOT/current-$LANE"',
  'legacy_current_blocks_arm',
  'maina.m0-sanitized-snapshot.v1',
  '^[A-Za-z0-9._-]{1,57}$',
  '^[A-Za-z0-9._-]{1,64}$',
];

for (const fragment of requiredFragments) {
  if (!source.includes(fragment)) {
    throw new Error(`M0 replay harness is missing required safety fragment: ${fragment}`);
  }
}

const safeLabelPattern = /^[A-Za-z0-9._-]{1,57}$/;
assert.equal(safeLabelPattern.test('a'), true);
assert.equal(safeLabelPattern.test('a'.repeat(57)), true);
assert.equal(safeLabelPattern.test('a'.repeat(58)), false);

if (source.includes('--terminate-existing')) {
  throw new Error('M0 replay harness must never terminate an active installed app or test.');
}
for (const forbidden of ['logcat -v', 'syslog live', 'screencap -p', 'dvt screenshot']) {
  if (source.includes(forbidden)) throw new Error(`M0 replay harness contains a raw evidence path: ${forbidden}`);
}
if (/0\.10\.34|CFBundleVersion\s*!==\s*"16"/.test(source)) {
  throw new Error('M0 replay harness contains a stale historical app version literal.');
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'maina-m0-interface-'));
const fakeBin = path.join(fixtureRoot, 'bin');
const evidenceRoot = path.join(fixtureRoot, 'evidence');
const toolLog = path.join(fixtureRoot, 'tool-invocations.log');
const fakeXcrun = path.join(fakeBin, 'xcrun');
const fixtureTmp = path.join(fixtureRoot, 'private-tmp');
const xcrunModeFile = path.join(fixtureRoot, 'xcrun-mode.txt');
mkdirSync(fakeBin, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });
mkdirSync(fixtureTmp, { recursive: true });
writeFileSync(xcrunModeFile, 'pass\n');

writeFileSync(path.join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\\n' "\${1:-}" >> "\${MAINA_M0_TOOL_LOG:?}"
if [[ "\${1:-}" == *'/scripts/release-provenance-cli.mjs' && "\${2:-}" == 'replay-config' ]]; then
  printf 'com.divay.maina\\t0.10.68\\t94\\tcom.divay.maina.staging\\t0.10.68\\t50\\n'
  exit 0
fi
exec '${process.execPath}' "$@"
`);
chmodSync(path.join(fakeBin, 'node'), 0o755);

writeFileSync(path.join(fakeBin, 'adb'), `#!/usr/bin/env bash
printf 'adb\\n' >> "\${MAINA_M0_TOOL_LOG:?}"
exit 99
`);
chmodSync(path.join(fakeBin, 'adb'), 0o755);

writeFileSync(path.join(fakeBin, 'date'), `#!/usr/bin/env bash
if [[ "$#" == '1' && "\${1:-}" == '+%H%M%S' ]]; then
  printf '120000\\n'
  exit 0
fi
exec /bin/date "$@"
`);
chmodSync(path.join(fakeBin, 'date'), 0o755);

writeFileSync(fakeXcrun, `#!/usr/bin/env bash
set -euo pipefail
printf 'xcrun %s\\n' "$*" >> "\${MAINA_M0_TOOL_LOG:?}"
mode="\${MAINA_M0_FAKE_XCRUN_MODE:-}"
if [[ -z "$mode" && -s "\${MAINA_M0_FAKE_XCRUN_MODE_FILE:-}" ]]; then
  mode="$(<"\${MAINA_M0_FAKE_XCRUN_MODE_FILE}")"
fi
mode="\${mode:-pass}"
[[ "$mode" != 'process_fail' || "$*" != *'device info processes'* ]] || exit 91
[[ "$mode" != 'list_fail' || "$*" != *'list devices'* ]] || exit 92
[[ "$mode" != 'apps_fail' || "$*" != *'device info apps'* ]] || exit 93
json_output=''
previous=''
for argument in "$@"; do
  if [[ "$previous" == '--json-output' ]]; then json_output="$argument"; fi
  previous="$argument"
done
if [[ "$*" == *'device info processes'* && -n "$json_output" ]]; then
  if [[ "$mode" == 'process_missing' ]]; then
    printf '{"result":{"runningProcesses":[]}}\\n' > "$json_output"
  elif [[ "$mode" == 'process_wrong_path' ]]; then
    printf '{"result":{"runningProcesses":[{"executable":"/private/var/containers/Bundle/Application/OTHER/Maina.app/Maina","processIdentifier":1234}]}}\\n' > "$json_output"
  elif [[ "$mode" == 'process_string_pid' ]]; then
    printf '{"result":{"runningProcesses":[{"executable":"/private/var/containers/Bundle/Application/TEST/Maina.app/Maina","processIdentifier":"1234"}]}}\\n' > "$json_output"
  elif [[ "$mode" == 'process_legacy_shape' ]]; then
    printf '{"result":{"processes":[{"executableURL":"file:///private/var/containers/Bundle/Application/TEST/Maina.app/Maina","processIdentifier":1234}]}}\\n' > "$json_output"
  else
    printf '{"result":{"runningProcesses":[{"executable":"/private/var/containers/Bundle/Application/TEST/Maina.app/Maina","processIdentifier":1234}]}}\\n' > "$json_output"
  fi
elif [[ "$*" == *'list devices'* ]]; then
  [[ -n "$json_output" ]]
  if [[ "$mode" == 'identity_invalid' ]]; then
    printf '{"result":{"devices":[]}}\\n' > "$json_output"
  else
    transport='wired'
    [[ "$mode" != 'transport_invalid' ]] || transport='localNetwork'
    printf '{"result":{"devices":[{"identifier":"945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD","hardwareProperties":{"udid":"00008120-001E146611E2601E","marketingName":"iPhone 15","reality":"physical"},"connectionProperties":{"transportType":"%s","tunnelState":"connected","pairingState":"paired"},"deviceProperties":{"developerModeStatus":"enabled"}}]}}\\n' "$transport" > "$json_output"
  fi
elif [[ "$*" == *'device info apps'* && -n "$json_output" ]]; then
  if [[ "$mode" == 'identity_invalid' || "$mode" == 'app_missing' ]]; then
    printf '{"result":{"apps":[]}}\\n' > "$json_output"
  elif [[ "$mode" == 'app_duplicate' ]]; then
    printf '{"result":{"apps":[{"bundleIdentifier":"com.divay.maina.staging","version":"0.10.68","bundleVersion":"50"},{"bundleIdentifier":"com.divay.maina.staging","version":"0.10.68","bundleVersion":"50"}]}}\\n' > "$json_output"
  elif [[ "$mode" == 'app_wrong_version' ]]; then
    printf '{"result":{"apps":[{"bundleIdentifier":"com.divay.maina.staging","version":"0.10.67","bundleVersion":"49","name":"Maina","url":"file:///private/var/containers/Bundle/Application/TEST/Maina.app/"}]}}\\n' > "$json_output"
  else
    printf '%s\\n' '{"result":{"apps":[{"bundleIdentifier":"com.divay.maina.staging","version":"0.10.68","bundleVersion":"50","name":"Maina","url":"file:///private/var/containers/Bundle/Application/TEST/Maina.app/"}]}}' > "$json_output"
  fi
fi
`);
chmodSync(fakeXcrun, 0o755);

const fixtureEnv = {
  ...process.env,
  PATH: `${fakeBin}:/usr/bin:/bin`,
  MAINA_M0_EVIDENCE_ROOT: evidenceRoot,
  MAINA_M0_TOOL_LOG: toolLog,
  MAINA_XCRUN: fakeXcrun,
  MAINA_M0_FAKE_XCRUN_MODE_FILE: xcrunModeFile,
  TMPDIR: fixtureTmp,
  MAINA_RELEASE_PROVENANCE: path.join(fixtureRoot, 'approved-provenance.json'),
};

const runHarness = (args) => spawnSync('/bin/bash', [harnessPath, ...args], {
  cwd: repoRoot,
  env: fixtureEnv,
  encoding: 'utf8',
});

function readIosCallKinds(logPath = toolLog) {
  const calls = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('xcrun '));
  const kinds = calls.map((line) => {
    if (line.includes('device info processes')) {
      if (line.includes('--json-output')) {
        assert.match(line, /--columns \* --json-output .*\/processes\.json --quiet --timeout 15$/);
        return 'runtime-process';
      }
      assert.match(line, /--timeout 15 --quiet$/);
      return 'process-proof';
    }
    if (line.includes('list devices')) {
      assert.match(line, /--json-output .*\/devices\.json --quiet --timeout 10$/);
      return 'list';
    }
    if (line.includes('device info apps')) {
      assert.match(line, /--bundle-id com\.divay\.maina\.staging --columns \* --json-output .*\/apps\.json --quiet --timeout 10$/);
      return 'apps';
    }
    throw new Error(`Unexpected synthetic CoreDevice command: ${line}`);
  });
  return kinds;
}

function assertPrivateTempsAbsent() {
  assert.deepEqual(
    readdirSync(fixtureTmp).filter((name) => name.startsWith('maina-m0-ios-')),
    [],
  );
}

function waitForMonitorStatus(logPath, status, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const lastLine = readFileSync(logPath, 'utf8').trimEnd().split('\n').at(-1) ?? '';
      if (lastLine.includes(`observer_status=${status} `)) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`Timed out waiting for synthetic iOS monitor status ${status}.`);
}

const boundaryLabel = 'a'.repeat(57);
const fixedSnapshotEntries = [
  'armed-ios-status.txt',
  'armed-timestamp.txt',
  `${boundaryLabel}-120000-ios-status.txt`,
  `${boundaryLabel}-120000-timestamp.txt`,
  'final-ios-status.txt',
  'final-timestamp.txt',
];
const validSnapshotEntries = [
  ...fixedSnapshotEntries,
  'bounded-check-120000-ios-status.txt',
  'bounded-check-120000-timestamp.txt',
].sort();

function validateSnapshotEntries(entries) {
  const actual = [...entries].sort();
  const manual = actual.filter((name) => name.startsWith('bounded-check-'));
  assert.equal(manual.length, 2);
  const parsed = manual.map((name) => name.match(/^bounded-check-([0-9]{6})-(ios-status|timestamp)\.txt$/));
  assert.equal(parsed.every(Boolean), true);
  assert.equal(parsed[0][1], parsed[1][1]);
  assert.deepEqual(new Set(parsed.map((match) => match[2])), new Set(['ios-status', 'timestamp']));
  assert.deepEqual(actual, [...fixedSnapshotEntries, ...manual].sort());
  return manual;
}

for (const invalidEntries of [
  validSnapshotEntries.filter((name) => name !== 'bounded-check-120000-timestamp.txt'),
  validSnapshotEntries.map((name) => name === 'bounded-check-120000-timestamp.txt' ? 'bounded-check-120001-timestamp.txt' : name),
  [...validSnapshotEntries, 'private.log'],
  [...validSnapshotEntries, 'bounded-check-120001-ios-status.txt', 'bounded-check-120001-timestamp.txt'],
]) {
  assert.throws(() => validateSnapshotEntries(invalidEntries));
}

try {
  const iosPreflight = runHarness(['ios', 'preflight']);
  assert.equal(iosPreflight.status, 0, iosPreflight.stderr);
  assert.match(iosPreflight.stdout, /M0 iOS replay preflight passed/);
  const validCalls = readFileSync(toolLog, 'utf8');
  assert.match(validCalls, /xcrun devicectl device info processes/);
  assert.match(validCalls, /xcrun devicectl list devices --json-output/);
  assert.match(validCalls, /xcrun devicectl device info apps/);
  assert.doesNotMatch(validCalls, /^adb$/m);
  assert.deepEqual(readIosCallKinds(), ['process-proof', 'list', 'apps']);
  assertPrivateTempsAbsent();

  for (const [mode, reason] of [
    ['process_fail', 'M0_IOS_CAPABILITY_PROOF_FAILED'],
    ['list_fail', 'M0_IOS_DEVICE_LIST_FAILED'],
    ['apps_fail', 'M0_IOS_APP_QUERY_FAILED'],
    ['identity_invalid', 'M0_IOS_IDENTITY_REJECTED'],
    ['transport_invalid', 'M0_IOS_IDENTITY_REJECTED'],
    ['app_missing', 'M0_IOS_IDENTITY_REJECTED'],
    ['app_duplicate', 'M0_IOS_IDENTITY_REJECTED'],
    ['app_wrong_version', 'M0_IOS_IDENTITY_REJECTED'],
  ]) {
    rmSync(toolLog, { force: true });
    const rejected = spawnSync('/bin/bash', [harnessPath, 'ios', 'preflight'], {
      cwd: repoRoot,
      env: { ...fixtureEnv, MAINA_M0_FAKE_XCRUN_MODE: mode },
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(reason));
    assert.doesNotMatch(rejected.stdout, /00008120-|com\.divay\.maina/);
    assert.doesNotMatch(rejected.stderr, /00008120-|com\.divay\.maina/);
    const expectedCalls = mode === 'process_fail'
      ? ['process-proof']
      : mode === 'list_fail'
        ? ['process-proof', 'list']
        : ['process-proof', 'list', 'apps'];
    assert.deepEqual(readIosCallKinds(), expectedCalls);
    assertPrivateTempsAbsent();
  }

  rmSync(toolLog, { force: true });
  const armed = runHarness(['ios', 'arm', 'test5-offline-recovery']);
  assert.equal(armed.status, 0, armed.stderr);
  const runId = readFileSync(path.join(evidenceRoot, 'current-ios'), 'utf8').trim();
  assert.match(runId, /^[0-9]{8}-[0-9]{6}-ios-test5-offline-recovery$/);
  assert.equal(existsSync(path.join(evidenceRoot, 'current-android')), false);
  const runDirectory = path.join(evidenceRoot, runId);

  for (const mode of [
    'transport_invalid',
    'process_missing',
    'process_wrong_path',
    'process_string_pid',
    'process_legacy_shape',
    'app_missing',
    'app_duplicate',
    'app_wrong_version',
  ]) {
    const label = `endpoint-${mode}`;
    const snapshotToolLog = path.join(fixtureRoot, `${label}-tools.log`);
    const unavailableSnapshot = spawnSync('/bin/bash', [harnessPath, 'ios', 'snapshot', label], {
      cwd: repoRoot,
      env: {
        ...fixtureEnv,
        MAINA_M0_FAKE_XCRUN_MODE: mode,
        MAINA_M0_TOOL_LOG: snapshotToolLog,
      },
      encoding: 'utf8',
    });
    assert.equal(unavailableSnapshot.status, 1);
    assert.match(unavailableSnapshot.stderr, /unavailable or mismatched installed app endpoint/);
    assert.match(
      readFileSync(path.join(runDirectory, 'snapshots', `${label}-120000-ios-status.txt`), 'utf8'),
      /app_endpoint_probe=FAIL/,
    );
    rmSync(path.join(runDirectory, 'snapshots', `${label}-120000-ios-status.txt`));
    rmSync(path.join(runDirectory, 'snapshots', `${label}-120000-timestamp.txt`));
    assert.deepEqual(readIosCallKinds(snapshotToolLog), ['list', 'runtime-process', 'apps']);
    assertPrivateTempsAbsent();
  }

  const health = runHarness(['ios', 'health']);
  assert.equal(health.status, 0, health.stderr);
  const monitorPid = Number(readFileSync(path.join(runDirectory, 'ios-observer.pid'), 'utf8').trim());
  const monitorLog = path.join(runDirectory, 'ios-observer.log');
  const freshMonitorLog = readFileSync(monitorLog, 'utf8');
  process.kill(monitorPid, 'SIGSTOP');
  try {
    writeFileSync(
      monitorLog,
      `${freshMonitorLog}2000-01-01T00:00:00Z lane=ios observer_status=PASS sample_epoch=1\n`,
    );
    const staleHealth = runHarness(['ios', 'health']);
    assert.equal(staleHealth.status, 1);
    assert.match(staleHealth.stderr, /last successful sample is stale/);
  } finally {
    writeFileSync(monitorLog, freshMonitorLog);
    process.kill(monitorPid, 'SIGCONT');
  }
  assertPrivateTempsAbsent();
  writeFileSync(xcrunModeFile, 'transport_invalid\n');
  waitForMonitorStatus(monitorLog, 'FAIL');
  const transportDriftHealth = runHarness(['ios', 'health']);
  assert.equal(transportDriftHealth.status, 1);
  assert.match(transportDriftHealth.stderr, /reports an unavailable endpoint/);
  assertPrivateTempsAbsent();
  writeFileSync(xcrunModeFile, 'pass\n');
  waitForMonitorStatus(monitorLog, 'PASS');
  const recoveredTransportHealth = runHarness(['ios', 'health']);
  assert.equal(recoveredTransportHealth.status, 0, recoveredTransportHealth.stderr);
  const boundarySnapshot = runHarness(['ios', 'snapshot', boundaryLabel]);
  assert.equal(boundarySnapshot.status, 0, boundarySnapshot.stderr);
  const snapshot = runHarness(['ios', 'snapshot', 'bounded-check']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const firstStatus = readFileSync(path.join(runDirectory, 'snapshots', 'bounded-check-120000-ios-status.txt'), 'utf8');
  const firstTimestamp = readFileSync(path.join(runDirectory, 'snapshots', 'bounded-check-120000-timestamp.txt'), 'utf8');
  const duplicateSnapshot = runHarness(['ios', 'snapshot', 'bounded-check']);
  assert.equal(duplicateSnapshot.status, 2);
  assert.match(duplicateSnapshot.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(path.join(runDirectory, 'snapshots', 'bounded-check-120000-ios-status.txt'), 'utf8'), firstStatus);
  assert.equal(readFileSync(path.join(runDirectory, 'snapshots', 'bounded-check-120000-timestamp.txt'), 'utf8'), firstTimestamp);

  const symlinkStatus = path.join(runDirectory, 'snapshots', 'symlink-check-120000-ios-status.txt');
  symlinkSync(path.join(fixtureRoot, 'missing-target'), symlinkStatus);
  const symlinkCollision = runHarness(['ios', 'snapshot', 'symlink-check']);
  assert.equal(symlinkCollision.status, 2);
  assert.match(symlinkCollision.stderr, /refusing to overwrite/);
  rmSync(symlinkStatus);
  const stopped = runHarness(['ios', 'stop']);
  assert.equal(stopped.status, 0, stopped.stderr);

  const lifecycleCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(lifecycleCalls, /^adb$/m);
  const directEntries = readdirSync(runDirectory).sort();
  assert.deepEqual(directEntries, [
    'ios-observer.log',
    'ios-observer.pid',
    'metadata.txt',
    'monitor-supervisor.log',
    'snapshots',
  ]);
  assert.equal(statSync(path.join(runDirectory, 'snapshots')).isDirectory(), true);
  assert.equal(statSync(runDirectory).mode & 0o777, 0o700);
  const snapshotEntries = readdirSync(path.join(runDirectory, 'snapshots')).sort();
  assert.deepEqual(snapshotEntries, validSnapshotEntries);
  const manualEntries = validateSnapshotEntries(snapshotEntries);
  assert.deepEqual(manualEntries, ['bounded-check-120000-ios-status.txt', 'bounded-check-120000-timestamp.txt']);
  for (const name of snapshotEntries) {
    assert.equal(statSync(path.join(runDirectory, 'snapshots', name)).mode & 0o777, 0o600);
  }
  const evidenceText = [
    ...directEntries.filter((name) => name !== 'snapshots').map((name) => readFileSync(path.join(runDirectory, name), 'utf8')),
    ...snapshotEntries.map((name) => readFileSync(path.join(runDirectory, 'snapshots', name), 'utf8')),
  ].join('\n');
  assert.match(evidenceText, /schemaVersion=maina\.m0-sanitized-snapshot\.v1/);
  assert.match(evidenceText, /lane=ios/);
  assert.match(evidenceText, /stopped_at=/);
  for (const privateToken of ['00008120-', 'MQLF6GV3XM', 'ConnectionType', 'CFBundle', 'com.divay.maina.staging']) {
    assert.doesNotMatch(evidenceText, new RegExp(privateToken));
  }

  for (const args of [
    [],
    ['preflight'],
    ['unknown', 'preflight'],
    ['ios'],
    ['ios', 'unknown'],
    ['ios', 'arm'],
    ['ios', 'arm', 'unknown'],
    ['ios', 'preflight', 'extra'],
    ['ios', 'snapshot', 'bad/label'],
    ['ios', 'snapshot', 'a'.repeat(58)],
  ]) {
    rmSync(toolLog, { force: true });
    const invalid = runHarness(args);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Usage:/);
    assert.equal(existsSync(toolLog), false, `Invalid interface invoked an external tool: ${args.join(' ')}`);
  }

  writeFileSync(path.join(evidenceRoot, 'current-ios'), '20260910-120000-android-test3-call-interruption\n');
  rmSync(toolLog, { force: true });
  const crossLaneBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(crossLaneBlocked.status, 1);
  assert.match(crossLaneBlocked.stderr, /active replay/);
  const crossLaneCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(crossLaneCalls, /^adb$/m);
  assert.doesNotMatch(crossLaneCalls, /^xcrun /m);
  rmSync(path.join(evidenceRoot, 'current-ios'));

  symlinkSync(path.join(fixtureRoot, 'outside-current-target'), path.join(evidenceRoot, 'current-ios'));
  rmSync(toolLog, { force: true });
  const laneSymlinkBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(laneSymlinkBlocked.status, 1);
  assert.match(laneSymlinkBlocked.stderr, /active replay/);
  const laneSymlinkCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(laneSymlinkCalls, /^adb$/m);
  assert.doesNotMatch(laneSymlinkCalls, /^xcrun /m);
  assert.equal(existsSync(path.join(fixtureRoot, 'outside-current-target')), false);
  rmSync(path.join(evidenceRoot, 'current-ios'));

  writeFileSync(path.join(evidenceRoot, 'current'), 'legacy-ambiguous-pointer\n');
  rmSync(toolLog, { force: true });
  const legacyBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(legacyBlocked.status, 1);
  assert.match(legacyBlocked.stderr, /legacy replay pointer exists/);
  const legacyCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(legacyCalls, /^adb$/m);
  assert.doesNotMatch(legacyCalls, /^xcrun /m);
  rmSync(path.join(evidenceRoot, 'current'));

  symlinkSync(path.join(fixtureRoot, 'outside-legacy-target'), path.join(evidenceRoot, 'current'));
  rmSync(toolLog, { force: true });
  const legacySymlinkBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(legacySymlinkBlocked.status, 1);
  assert.match(legacySymlinkBlocked.stderr, /legacy replay pointer exists/);
  const legacySymlinkCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(legacySymlinkCalls, /^adb$/m);
  assert.doesNotMatch(legacySymlinkCalls, /^xcrun /m);
  assert.equal(existsSync(path.join(fixtureRoot, 'outside-legacy-target')), false);

  assert.notEqual(path.join(evidenceRoot, 'current-ios'), path.join(evidenceRoot, 'current-android'));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('M0 replay harness static and lane-interface safety verification passed.');
