#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
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
  'xcode',
  'ios_sdk',
  'xcodebuild',
  'ios_device_endpoint',
  'ios_signing_and_provisioning_readiness',
  'pymobiledevice3',
]);

export function collectIosPreflight({
  env = process.env,
  run = runCommand,
  listProfiles = collectProvisioningProfiles,
  nowMs = Date.now(),
} = {}) {
  const results = [];
  const record = (capability, passed, reasonCode) => {
    results.push(passed ? { capability, status: 'PASS' } : { capability, status: 'FAIL', reasonCode });
  };

  const nodeBin = env.MAINA_IOS_NODE_BIN ?? '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin';
  const deviceId = env.MAINA_IOS_DEVICE_ID ?? '945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD';
  const teamId = env.MAINA_IOS_TEAM_ID ?? '9X4X3R4KCN';
  const pymobiledevice3 = env.MAINA_PMD ?? '/Users/divay/Developer/.tools/maina-pymobiledevice3/bin/pymobiledevice3';

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
  const expectedRevision = env.MAINA_EXPECTED_FINAL_COMMIT ?? '';
  record(
    'source_revision',
    head.ok && upstream.ok && /^[a-f0-9]{40}$/.test(expectedRevision)
      && head.stdout.trim() === expectedRevision && upstream.stdout.trim() === expectedRevision,
    'SOURCE_REVISION_MISMATCH',
  );
  const status = run('git', ['-C', projectDir, 'status', '--porcelain']);
  record('clean_worktree', status.ok && status.stdout === '', 'SOURCE_WORKTREE_DIRTY');

  const helpers = [
    'scripts/build-ios-release-candidate.sh',
    'scripts/install-ios-preserving-data.sh',
    'scripts/release-provenance-cli.mjs',
    'scripts/lib/renewal-core.mjs',
    'release/m3-m4-0.10.51-candidate-plan.json',
  ];
  record('helper_runtime', helpers.every((path) => isReadable(join(projectDir, path))), 'HELPER_RUNTIME_UNAVAILABLE');

  const xcode = run('/usr/bin/xcodebuild', ['-version']);
  record('xcode', xcode.ok && /^Xcode [0-9]+(?:\.[0-9]+)*$/m.test(xcode.stdout), 'XCODE_UNAVAILABLE');

  const sdkVersion = run('/usr/bin/xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']);
  const sdkPath = run('/usr/bin/xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']);
  record(
    'ios_sdk',
    sdkVersion.ok && /^[0-9]+(?:\.[0-9]+)*$/.test(sdkVersion.stdout.trim())
      && sdkPath.ok && sdkPath.stdout.trim().startsWith('/Applications/Xcode.app/'),
    'IOS_SDK_UNAVAILABLE',
  );

  const xcodebuild = run('/usr/bin/xcrun', ['--find', 'xcodebuild']);
  const firstLaunch = run('/usr/bin/xcodebuild', ['-checkFirstLaunchStatus']);
  record(
    'xcodebuild',
    xcodebuild.ok && xcodebuild.stdout.trim().startsWith('/Applications/Xcode.app/') && firstLaunch.ok,
    'XCODEBUILD_NOT_READY',
  );

  const endpoint = run('/usr/bin/xcrun', [
    'devicectl', 'device', 'info', 'processes', '--device', deviceId, '--timeout', '15', '--quiet',
  ]);
  record('ios_device_endpoint', endpoint.ok, 'IOS_DEVICE_ENDPOINT_UNAVAILABLE');

  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const plan = loadReleasePlan();
  const profiles = listProfiles({ env, run });
  record(
    'ios_signing_and_provisioning_readiness',
    identities.ok && evaluateIosSigningReadiness({
      plan,
      teamId,
      identityOutput: `${identities.stdout}\n${identities.stderr}`,
      profiles,
      nowMs,
    }),
    'IOS_SIGNING_NOT_READY',
  );

  const pmd = run(pymobiledevice3, ['--version']);
  record('pymobiledevice3', pmd.ok && pmd.stdout.trim().length > 0, 'PYMOBILEDEVICE3_UNAVAILABLE');

  return Object.freeze(results.map((result) => Object.freeze(result)));
}

export function evaluateIosPreflight(results) {
  assert.deepEqual(
    [...results].map(({ capability }) => capability).sort(compareCodeUnits),
    [...expectedCapabilities].sort(compareCodeUnits),
    'IOS_PREFLIGHT_CAPABILITY_SET_MISMATCH',
  );
  return evaluatePreflight(loadContract(), 'ios', results);
}

function loadContract() {
  return JSON.parse(readFileSync(join(projectDir, 'coordination', 'operations', 'contracts', 'qualification-harness.v1.json'), 'utf8'));
}

function loadReleasePlan() {
  return JSON.parse(readFileSync(join(projectDir, 'release', 'm3-m4-0.10.51-candidate-plan.json'), 'utf8'));
}

function runCommand(command, args, { input } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env, input });
  return Object.freeze({ ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
}

function collectProvisioningProfiles({ env, run }) {
  const directories = env.MAINA_IOS_PROVISIONING_PROFILE_DIRS
    ? env.MAINA_IOS_PROVISIONING_PROFILE_DIRS.split(delimiter).filter(Boolean)
    : [
        join(env.HOME ?? homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
        join(env.HOME ?? homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
      ];
  const profiles = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:mobileprovision|provisionprofile)$/.test(entry.name)) continue;
      const decoded = run('/usr/bin/security', ['cms', '-D', '-i', join(directory, entry.name)]);
      if (!decoded.ok) continue;
      const converted = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: decoded.stdout });
      if (!converted.ok) continue;
      try {
        profiles.push(JSON.parse(converted.stdout));
      } catch {
        // A malformed profile is unavailable, not evidence for readiness.
      }
    }
  }
  return profiles;
}

export function evaluateIosSigningReadiness({ plan, teamId, identityOutput, profiles, nowMs }) {
  if (teamId !== plan.identity.iosTeamId) return false;
  const policy = plan.artifactPolicy.ios;
  const identityName = policy.designatedRequirement.match(/certificate leaf\[subject\.CN\] = "([^"]+)"/)?.[1];
  if (!identityName?.startsWith('Apple Development: ')) return false;
  if (!policy.designatedRequirement.includes(`identifier "${plan.identity.iosBundleIdentifier}"`)) return false;
  const escapedIdentity = identityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const identityMatch = identityOutput.match(new RegExp(`\\b([A-Fa-f0-9]{40})\\b[^\\n]*"${escapedIdentity}"`));
  if (!identityMatch || !/[1-9][0-9]* valid identities found/.test(identityOutput)) return false;
  const identitySha1 = identityMatch[1].toLowerCase();
  const minimumExpiryMs = nowMs + plan.toolchains.ios.minimumProfileWindowHours * 60 * 60 * 1000;

  return profiles.some((profile) => {
    const entitlements = profile?.Entitlements;
    const expirationMs = Date.parse(profile?.ExpirationDate ?? '');
    const certificateMatches = Array.isArray(profile?.DeveloperCertificates)
      && profile.DeveloperCertificates.some((certificate) => {
        try {
          return createHash('sha1').update(Buffer.from(certificate, 'base64')).digest('hex') === identitySha1;
        } catch {
          return false;
        }
      });
    return profile?.Name === policy.profileName
      && Array.isArray(profile?.TeamIdentifier)
      && profile.TeamIdentifier.length === 1
      && profile.TeamIdentifier[0] === plan.identity.iosTeamId
      && canonicalJson(entitlements) === canonicalJson(policy.profileEntitlements)
      && entitlements?.['application-identifier'] === `${plan.identity.iosTeamId}.${plan.identity.iosBundleIdentifier}`
      && entitlements?.['com.apple.developer.team-identifier'] === plan.identity.iosTeamId
      && certificateMatches
      && Number.isFinite(expirationMs)
      && expirationMs > minimumExpiryMs;
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function isReadable(path) {
  try {
    accessSync(path, constants.R_OK);
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

export async function selfTest() {
  const revision = 'a'.repeat(40);
  const plan = loadReleasePlan();
  const certificate = Buffer.from('synthetic-plan-bound-apple-development-certificate');
  const certificateSha1 = createHash('sha1').update(certificate).digest('hex').toUpperCase();
  const identityName = plan.artifactPolicy.ios.designatedRequirement.match(/certificate leaf\[subject\.CN\] = "([^"]+)"/)?.[1];
  const identityOutput = `  1) ${certificateSha1} "${identityName}"\n     1 valid identities found\n`;
  const nowMs = Date.parse('2026-09-05T00:00:00Z');
  const validProfile = {
    Name: plan.artifactPolicy.ios.profileName,
    TeamIdentifier: [plan.identity.iosTeamId],
    Entitlements: structuredClone(plan.artifactPolicy.ios.profileEntitlements),
    DeveloperCertificates: [certificate.toString('base64')],
    ExpirationDate: new Date(nowMs + 49 * 60 * 60 * 1000).toISOString(),
  };
  const syntheticRun = (command, args) => {
    if (command === '/synthetic/node/node') return result('v24.19.0\n');
    if (command === storageGuard) return result(`${expectedStorageRoot}\n`);
    if (command === 'git' && args.includes('status')) return result('');
    if (command === 'git') return result(`${revision}\n`);
    if (command === '/usr/bin/xcodebuild' && args.includes('-version')) return result('Xcode 26.0\nBuild version 17A324\n');
    if (command === '/usr/bin/xcodebuild') return result('');
    if (command === '/usr/bin/xcrun' && args.includes('--show-sdk-version')) return result('26.0\n');
    if (command === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) return result('/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.0.sdk\n');
    if (command === '/usr/bin/xcrun' && args.includes('--find')) return result('/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild\n');
    if (command === '/usr/bin/xcrun' && args.includes('devicectl')) return result('');
    if (command === '/usr/bin/security') return result(identityOutput);
    if (command === '/synthetic/pymobiledevice3') return result('pymobiledevice3 4.0.0\n');
    throw new Error(`UNEXPECTED_SYNTHETIC_COMMAND:${command}`);
  };
  const syntheticEnv = {
    ...process.env,
    MAINA_EXPECTED_FINAL_COMMIT: revision,
    MAINA_IOS_NODE_BIN: '/synthetic/node',
    MAINA_IOS_TEAM_ID: plan.identity.iosTeamId,
    MAINA_PMD: '/synthetic/pymobiledevice3',
  };
  const syntheticResults = collectIosPreflight({
    env: syntheticEnv,
    run: syntheticRun,
    listProfiles: () => [validProfile],
    nowMs,
  });
  assert.ok(syntheticResults.every(({ status }) => status === 'PASS'));
  const missingRevision = collectIosPreflight({
    env: { ...syntheticEnv, MAINA_EXPECTED_FINAL_COMMIT: '' },
    run: syntheticRun,
    listProfiles: () => [validProfile],
    nowMs,
  });
  assert.deepEqual(missingRevision.find(({ capability }) => capability === 'source_revision'), {
    capability: 'source_revision', status: 'FAIL', reasonCode: 'SOURCE_REVISION_MISMATCH',
  });
  const driftRevision = collectIosPreflight({
    env: { ...syntheticEnv, MAINA_EXPECTED_FINAL_COMMIT: 'b'.repeat(40) },
    run: syntheticRun,
    listProfiles: () => [validProfile],
    nowMs,
  });
  assert.equal(driftRevision.find(({ capability }) => capability === 'source_revision')?.status, 'FAIL');

  const signing = (overrides = {}) => evaluateIosSigningReadiness({
    plan,
    teamId: plan.identity.iosTeamId,
    identityOutput,
    profiles: [validProfile],
    nowMs,
    ...overrides,
  });
  assert.equal(signing(), true);
  assert.equal(signing({ identityOutput: '  1) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "Developer ID Application: Unrelated Corp (WRONGTEAM)"\n     1 valid identities found\n' }), false);
  assert.equal(signing({ profiles: [] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, Name: 'Wrong profile' }] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, TeamIdentifier: ['WRONGTEAM'] }] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, Entitlements: { ...validProfile.Entitlements, 'application-identifier': '9X4X3R4KCN.com.divay.other' } }] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, Entitlements: { ...validProfile.Entitlements, 'get-task-allow': false } }] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, ExpirationDate: new Date(nowMs + 48 * 60 * 60 * 1000).toISOString() }] }), false);
  assert.equal(signing({ profiles: [{ ...validProfile, DeveloperCertificates: [Buffer.from('wrong').toString('base64')] }] }), false);

  const passResults = expectedCapabilities.map((capability) => ({ capability, status: 'PASS' }));
  assert.equal(evaluateIosPreflight(passResults).state, 'PASS');
  const failedResults = passResults.map((result) => result.capability === 'ios_device_endpoint'
    ? { capability: result.capability, status: 'FAIL', reasonCode: 'IOS_DEVICE_ENDPOINT_UNAVAILABLE' }
    : result);
  assert.deepEqual(evaluateIosPreflight(failedResults), {
    state: 'BLOCKED',
    lane: 'ios',
    reasonCodes: ['IOS_DEVICE_ENDPOINT_UNAVAILABLE'],
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
  assert.deepEqual(
    { attempts: observer.attempts, mutationAttempts: observer.mutationAttempts, lock: observer.reconciliationLock },
    { attempts: 3, mutationAttempts: 0, lock: 'ABSENT' },
  );

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
  const build = source('scripts/build-ios-release-candidate.sh');
  assertOrder(build, [
    'ios-lane.mjs" preflight',
    'source "$PROJECT_DIR/scripts/maina-ios-env.sh"',
    'maina_storage_mkdir "$OUTPUT_DIR"',
    'mkdir "$LOCK_DIR"',
    'write_lock_state "mutation_started"',
    ': > "$OUTPUT_DIR/build-attempted"',
    'xcodebuild -workspace',
  ], 'IOS_BUILD_MUTATION_BOUNDARY_INVALID');
  const installer = source('scripts/install-ios-preserving-data.sh');
  assertOrder(installer, [
    'release-provenance-cli.mjs authorize ios',
    'ios-lane.mjs" preflight',
    'preflight-container',
    'Approved app bundle identifier mismatch',
    'mkdir "$LOCK_DIR"',
    'write_lock_state "mutation_started"',
    'device install app',
  ], 'IOS_INSTALL_MUTATION_BOUNDARY_INVALID');
  assert.match(installer, /mutation_started=0/);
  assert.match(installer, /mutation_started" == "1"/);
  assert.match(installer, /MAINA_EXPECTED_FINAL_COMMIT:\?Set the exact independently accepted P0H-04 tooling commit/);
  assert.doesNotMatch(installer, /TOOLING_HEAD=.*git rev-parse HEAD/);
  assert.equal((installer.match(/device install app/g) ?? []).length, 1);
  assert.doesNotMatch(installer, /device=%s|bundle=%s|retained lock:|raw_exception/);

  console.log('iOS qualification adapter self-tests passed (preflight 5, signing 9, observer 1, mutation 2, script boundaries 13).');
}

function result(stdout, { ok = true, stderr = '' } = {}) {
  return Object.freeze({ ok, stdout, stderr });
}

function assertOrder(source, fragments, code) {
  let cursor = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.ok(index > cursor, `${code}:${fragment}`);
    cursor = index;
  }
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  if (process.argv[2] !== 'preflight') throw new Error('Usage: ios-lane.mjs preflight | --self-test');
  const results = collectIosPreflight();
  const evaluation = evaluateIosPreflight(results);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'maina.ios-qualification-preflight.v1', lane: 'ios', status: evaluation.state, results })}\n`);
  if (evaluation.state !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('IOS_QUALIFICATION_ADAPTER_FAILED\n');
    process.exitCode = 1;
  });
}
