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
  'ConnectionType !== "USB"',
  'ProductType !== "iPhone15,4"',
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
for (const forbidden of ['logcat -v', 'syslog live', 'screencap -p', 'dvt screenshot', 'device info processes']) {
  if (source.includes(forbidden)) throw new Error(`M0 replay harness contains a raw evidence path: ${forbidden}`);
}
if (/0\.10\.34|CFBundleVersion\s*!==\s*"16"/.test(source)) {
  throw new Error('M0 replay harness contains a stale historical app version literal.');
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'maina-m0-interface-'));
const fakeBin = path.join(fixtureRoot, 'bin');
const evidenceRoot = path.join(fixtureRoot, 'evidence');
const toolLog = path.join(fixtureRoot, 'tool-invocations.log');
const fakePmd = path.join(fakeBin, 'pymobiledevice3');
mkdirSync(fakeBin, { recursive: true });
mkdirSync(evidenceRoot, { recursive: true });

writeFileSync(path.join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\\n' "\${1:-}" >> "\${MAINA_M0_TOOL_LOG:?}"
if [[ "\${1:-}" == *'/scripts/release-provenance-cli.mjs' && "\${2:-}" == 'replay-config' ]]; then
  printf 'com.divay.maina\\t0.10.67\\t93\\tcom.divay.maina.staging\\t0.10.67\\t49\\n'
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

writeFileSync(fakePmd, `#!/usr/bin/env bash
set -euo pipefail
printf 'pmd %s\\n' "$*" >> "\${MAINA_M0_TOOL_LOG:?}"
case "\${1:-}:\${2:-}" in
  usbmux:list)
    printf '[{"Identifier":"00008120-001E146611E2601E","ConnectionType":"USB","ProductType":"iPhone15,4"}]\\n'
    ;;
  apps:query)
    printf '{"com.divay.maina.staging":{"CFBundleShortVersionString":"0.10.67","CFBundleVersion":"49"}}\\n'
    ;;
  *) exit 98 ;;
esac
`);
chmodSync(fakePmd, 0o755);

const fixtureEnv = {
  ...process.env,
  PATH: `${fakeBin}:/usr/bin:/bin`,
  MAINA_M0_EVIDENCE_ROOT: evidenceRoot,
  MAINA_M0_TOOL_LOG: toolLog,
  MAINA_PMD: fakePmd,
  MAINA_RELEASE_PROVENANCE: path.join(fixtureRoot, 'approved-provenance.json'),
};

const runHarness = (args) => spawnSync('/bin/bash', [harnessPath, ...args], {
  cwd: repoRoot,
  env: fixtureEnv,
  encoding: 'utf8',
});

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
  assert.match(validCalls, /pmd usbmux list/);
  assert.match(validCalls, /pmd apps query com\.divay\.maina\.staging/);
  assert.doesNotMatch(validCalls, /^adb$/m);

  rmSync(toolLog, { force: true });
  const armed = runHarness(['ios', 'arm', 'test5-offline-recovery']);
  assert.equal(armed.status, 0, armed.stderr);
  const runId = readFileSync(path.join(evidenceRoot, 'current-ios'), 'utf8').trim();
  assert.match(runId, /^[0-9]{8}-[0-9]{6}-ios-test5-offline-recovery$/);
  assert.equal(existsSync(path.join(evidenceRoot, 'current-android')), false);
  const runDirectory = path.join(evidenceRoot, runId);

  const health = runHarness(['ios', 'health']);
  assert.equal(health.status, 0, health.stderr);
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
  assert.doesNotMatch(crossLaneCalls, /^pmd /m);
  rmSync(path.join(evidenceRoot, 'current-ios'));

  symlinkSync(path.join(fixtureRoot, 'outside-current-target'), path.join(evidenceRoot, 'current-ios'));
  rmSync(toolLog, { force: true });
  const laneSymlinkBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(laneSymlinkBlocked.status, 1);
  assert.match(laneSymlinkBlocked.stderr, /active replay/);
  const laneSymlinkCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(laneSymlinkCalls, /^adb$/m);
  assert.doesNotMatch(laneSymlinkCalls, /^pmd /m);
  assert.equal(existsSync(path.join(fixtureRoot, 'outside-current-target')), false);
  rmSync(path.join(evidenceRoot, 'current-ios'));

  writeFileSync(path.join(evidenceRoot, 'current'), 'legacy-ambiguous-pointer\n');
  rmSync(toolLog, { force: true });
  const legacyBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(legacyBlocked.status, 1);
  assert.match(legacyBlocked.stderr, /legacy replay pointer exists/);
  const legacyCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(legacyCalls, /^adb$/m);
  assert.doesNotMatch(legacyCalls, /^pmd /m);
  rmSync(path.join(evidenceRoot, 'current'));

  symlinkSync(path.join(fixtureRoot, 'outside-legacy-target'), path.join(evidenceRoot, 'current'));
  rmSync(toolLog, { force: true });
  const legacySymlinkBlocked = runHarness(['ios', 'arm', 'test3-call-interruption']);
  assert.equal(legacySymlinkBlocked.status, 1);
  assert.match(legacySymlinkBlocked.stderr, /legacy replay pointer exists/);
  const legacySymlinkCalls = readFileSync(toolLog, 'utf8');
  assert.doesNotMatch(legacySymlinkCalls, /^adb$/m);
  assert.doesNotMatch(legacySymlinkCalls, /^pmd /m);
  assert.equal(existsSync(path.join(fixtureRoot, 'outside-legacy-target')), false);

  assert.notEqual(path.join(evidenceRoot, 'current-ios'), path.join(evidenceRoot, 'current-android'));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('M0 replay harness static and lane-interface safety verification passed.');
