#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GUARD = '/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh';
const GUARD_SHA256 = 'e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f';
const GUARD_BYTES = 3387;
const STORAGE_ROOT = '/Volumes/DivaySSD/MainaBuild';
const INTERNAL_BUILD_ROOT = '/Users/divay/.cache/maina-build-v2';
const root = path.resolve(import.meta.dirname, '..');
const kind = root === '/Users/divay/Developer/MainaV2'
  ? 'android-main'
  : root === '/Users/divay/Developer/.worktrees/maina-ios-feasibility'
    ? 'ios-feasibility'
    : null;
assert.ok(kind, 'Storage verification must run from an approved canonical Apps worktree.');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const runBash = (body, args = [], env = {}) => spawnSync(
  '/bin/bash',
  ['-c', body, 'maina-storage-verifier', ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } },
);
const assertOrder = (source, ordered, label) => {
  let cursor = -1;
  for (const token of ordered) {
    const next = source.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} must preserve ordering at: ${token}`);
    cursor = next;
  }
};
const assertExternal = (candidate, label) => {
  assert.ok(
    candidate === STORAGE_ROOT || candidate.startsWith(`${STORAGE_ROOT}/`),
    `${label} must resolve under the guarded external root: ${candidate}`,
  );
};

const guardStat = lstatSync(GUARD);
assert.equal(guardStat.isFile(), true);
assert.equal(guardStat.isSymbolicLink(), false);
assert.equal(guardStat.mode & 0o777, 0o755);
assert.equal(guardStat.size, GUARD_BYTES);
assert.equal(sha256(readFileSync(GUARD)), GUARD_SHA256);
const guardResult = spawnSync(GUARD, [], { encoding: 'utf8' });
assert.equal(guardResult.status, 0);
assert.equal(guardResult.stdout, `${STORAGE_ROOT}\n`);
assert.equal(guardResult.stderr, '');

const binding = read('scripts/maina-storage.sh');
assert.match(binding, new RegExp(GUARD.replaceAll('/', '\\/')));
assert.match(binding, new RegExp(GUARD_SHA256));
assert.match(binding, /MAINA_STORAGE_GUARD_BYTES='3387'/);
assert.match(binding, /MAINA_STORAGE_GUARD_MODE='755'/);
assert.match(binding, /storage_root="\$\("\$MAINA_STORAGE_GUARD"\)"/);
assert.doesNotMatch(binding, /diskutil|noowners|Owners Enabled|49AA36BA-D050-492B-97B3-469100800A11/);
assert.match(binding, /refusing fallback/);

const counterpartRoot = kind === 'android-main'
  ? '/Users/divay/Developer/.worktrees/maina-ios-feasibility'
  : '/Users/divay/Developer/MainaV2';
assert.equal(
  readFileSync(path.join(counterpartRoot, 'scripts/maina-storage.sh'), 'utf8'),
  binding,
  'The shared guard binding must stay byte-identical across canonical worktrees.',
);
assert.equal(
  readFileSync(path.join(counterpartRoot, 'scripts/maina-build-env.sh'), 'utf8'),
  read('scripts/maina-build-env.sh'),
  'The Android build environment must stay byte-identical across canonical worktrees.',
);
assert.equal(
  readFileSync(path.join(counterpartRoot, 'scripts/restore-external-build-links.sh'), 'utf8'),
  read('scripts/restore-external-build-links.sh'),
  'The generated-link restorer must stay byte-identical across canonical worktrees.',
);
assert.equal(
  readFileSync(path.join(counterpartRoot, 'scripts/gradle-output-redirect.init.gradle'), 'utf8'),
  read('scripts/gradle-output-redirect.init.gradle'),
  'The Gradle output redirect must stay byte-identical across canonical worktrees.',
);

const scratchParent = path.join(STORAGE_ROOT, 'scratch/apps/tests/storage-contract');
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(path.join(scratchParent, `${kind}-`));
try {
  const badHashBinding = path.join(scratch, 'bad-hash-binding.sh');
  writeFileSync(badHashBinding, binding.replace(GUARD_SHA256, '0'.repeat(64)), { mode: 0o600 });
  const badHash = runBash('source "$1"', [badHashBinding]);
  assert.equal(badHash.status, 78);
  assert.match(badHash.stderr, /identity changed; refusing fallback/);

  const missingBinding = path.join(scratch, 'missing-binding.sh');
  writeFileSync(missingBinding, binding.replace(GUARD, path.join(scratch, 'absent-guard.sh')), { mode: 0o600 });
  const missing = runBash('source "$1"', [missingBinding]);
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /missing or unsafe; refusing fallback/);

  const modeGuard = path.join(scratch, 'wrong-mode-guard.sh');
  writeFileSync(modeGuard, readFileSync(GUARD), { mode: 0o644 });
  chmodSync(modeGuard, 0o644);
  const modeBinding = path.join(scratch, 'wrong-mode-binding.sh');
  writeFileSync(modeBinding, binding.replace(GUARD, modeGuard), { mode: 0o600 });
  const wrongMode = runBash('source "$1"', [modeBinding]);
  assert.equal(wrongMode.status, 78);
  assert.match(wrongMode.stderr, /missing or unsafe; refusing fallback/);

  const internalProbe = path.join(INTERNAL_BUILD_ROOT, 'outputs', `storage-contract-must-not-write-${randomUUID()}`);
  const rejectedPath = runBash(
    'source "$1"; maina_require_storage_path "$2"',
    [path.join(root, 'scripts/maina-storage.sh'), internalProbe],
  );
  assert.equal(rejectedPath.status, 78);
  assert.match(rejectedPath.stderr, /escapes the guarded external root/);

  const traversal = runBash(
    'source "$1"; maina_require_storage_path "$2"',
    [path.join(root, 'scripts/maina-storage.sh'), STORAGE_ROOT + '/scratch/../escape'],
  );
  assert.equal(traversal.status, 78);
  assert.match(traversal.stderr, /traversal/);

  const escapeLink = path.join(scratch, 'escape-link');
  symlinkSync(path.join(INTERNAL_BUILD_ROOT, 'outputs'), escapeLink);
  const symlinkEscape = runBash(
    'source "$1"; maina_require_storage_path "$2"',
    [path.join(root, 'scripts/maina-storage.sh'), path.join(escapeLink, 'child')],
  );
  assert.equal(symlinkEscape.status, 78);
  assert.match(symlinkEscape.stderr, /resolves outside/);
} finally {
  assert.ok(scratch.startsWith(`${scratchParent}/${kind}-`), 'Refusing broad storage-test cleanup.');
  rmSync(scratch, { recursive: true, force: true });
}

const envScriptPath = path.join(root, 'scripts/maina-build-env.sh');
const envProbe = runBash(
  [
    'set -euo pipefail',
    'source "$1"',
    'printf "%s\\n" "$MAINA_STORAGE_ROOT" "$MAINA_STORAGE_SLOT" "$MAINA_BUILD_ROOT"',
    'printf "%s\\n" "$MAINA_ANDROID_OUTPUT_ROOT" "$MAINA_ANDROID_NATIVE_ROOT"',
    'printf "%s\\n" "$MAINA_GRADLE_USER_HOME" "$(/bin/realpath "$MAINA_GRADLE_USER_HOME")"',
    'printf "%s\\n" "$MAINA_GRADLE_PROJECT_CACHE" "$(/bin/realpath "$MAINA_GRADLE_PROJECT_CACHE")"',
    'printf "%s\\n" "$MAINA_ANDROID_TEMP_ROOT" "$MAINA_RELEASE_OUTPUT_ROOT" "$MAINA_NODE_DEPENDENCY_ROOT" "$TMPDIR"',
  ].join('\n'),
  [envScriptPath],
);
assert.equal(envProbe.status, 0, envProbe.stderr);
const [
  probedRoot,
  probedSlot,
  protectedRoot,
  androidOutput,
  androidNative,
  gradleUserLink,
  gradleUserTarget,
  gradleProjectLink,
  gradleProjectTarget,
  androidTemp,
  releaseOutput,
  nodeDependency,
  tempDir,
] = envProbe.stdout.trim().split('\n');
assert.equal(probedRoot, STORAGE_ROOT);
assert.equal(probedSlot, kind);
assert.equal(protectedRoot, INTERNAL_BUILD_ROOT);
assert.equal(gradleUserLink, `${INTERNAL_BUILD_ROOT}/gradle-user-home`);
assert.equal(gradleProjectLink, `${INTERNAL_BUILD_ROOT}/gradle-project-cache`);
assert.equal(gradleUserTarget, `${STORAGE_ROOT}/caches/android/gradle-user-home`);
assert.equal(gradleProjectTarget, `${STORAGE_ROOT}/caches/android/gradle-project-cache`);
for (const [candidate, label] of [
  [androidOutput, 'Android output'],
  [androidNative, 'Android native output'],
  [gradleUserTarget, 'Gradle user home target'],
  [gradleProjectTarget, 'Gradle project cache target'],
  [androidTemp, 'Android temp'],
  [releaseOutput, 'release output'],
  [nodeDependency, 'Node dependency'],
  [tempDir, 'TMPDIR'],
]) assertExternal(candidate, label);

assert.equal(lstatSync(INTERNAL_BUILD_ROOT).isSymbolicLink(), false);
assert.equal(lstatSync(path.join(INTERNAL_BUILD_ROOT, 'outputs')).isSymbolicLink(), false);
assert.equal(statSync(INTERNAL_BUILD_ROOT).dev, statSync('/').dev);
assert.equal(statSync(path.join(INTERNAL_BUILD_ROOT, 'outputs')).dev, statSync('/').dev);
assert.deepEqual(
  readdirSync(INTERNAL_BUILD_ROOT)
    .filter((name) => lstatSync(path.join(INTERNAL_BUILD_ROOT, name)).isSymbolicLink())
    .sort(),
  ['gradle-project-cache', 'gradle-user-home'],
);
assert.equal(lstatSync(gradleUserLink).isSymbolicLink(), true);
assert.equal(lstatSync(gradleProjectLink).isSymbolicLink(), true);
assert.equal(lstatSync('/Users/divay/.cache/maina-gradle-project').isSymbolicLink(), true);
assert.equal(
  realpathSync('/Users/divay/.cache/maina-gradle-project'),
  `${STORAGE_ROOT}/caches/android/maina-gradle-project`,
  'The standalone Gradle project cache must retain its exact approved SSD target.',
);
assert.equal(lstatSync(path.join(root, 'node_modules')).isSymbolicLink(), true);
assert.equal(realpathSync(path.join(root, 'node_modules')), path.join(STORAGE_ROOT, 'dependencies/apps', kind, 'node_modules'));

const protectedOverride = runBash(
  'source "$1"',
  [envScriptPath],
  { MAINA_BUILD_ROOT: path.join(STORAGE_ROOT, 'forbidden-build-parent') },
);
assert.equal(protectedOverride.status, 78);
assert.match(protectedOverride.stderr, /protected internal Maina build parent/);
const cacheOverride = runBash(
  'source "$1"',
  [envScriptPath],
  { MAINA_GRADLE_USER_HOME: path.join(STORAGE_ROOT, 'forbidden-direct-gradle-home') },
);
assert.equal(cacheOverride.status, 78);
assert.match(cacheOverride.stderr, /Only the two approved children/);

const runtimeEnv = read('scripts/maina-env.sh');
assert.doesNotMatch(runtimeEnv, /maina-storage\.sh|MAINA_STORAGE_ROOT/);
const mainaBuildEnv = read('scripts/maina-build-env.sh');
assertOrder(mainaBuildEnv, ['source "$MAINA_BUILD_ENV_REPO_ROOT/scripts/maina-storage.sh"', "MAINA_BUILD_ROOT=\"\${MAINA_BUILD_ROOT:-/Users/divay/.cache/maina-build-v2}\"", 'source "$MAINA_BUILD_ENV_REPO_ROOT/scripts/maina-env.sh"', 'maina_storage_mkdir "$MAINA_ANDROID_OUTPUT_ROOT"'], 'Android build environment');
assert.doesNotMatch(mainaBuildEnv, /maina_storage_mkdir "\$MAINA_BUILD_ROOT(?:\/outputs)?"/);
const linkRestorer = read('scripts/restore-external-build-links.sh');
assert.equal(lstatSync(path.join(root, 'scripts/restore-external-build-links.sh')).mode & 0o777, 0o755);
assertOrder(linkRestorer, ['source "$PROJECT_DIR/scripts/maina-storage.sh"', 'maina_require_storage_path "$target_path"', '/bin/ln -s'], 'link restorer');
assert.doesNotMatch(linkRestorer, /\brm\b/);
assert.match(linkRestorer, /"\$PROJECT_DIR\/android\/\.gradle"/);
assert.match(linkRestorer, /caches\/android\/gradle-project-cache/);
assert.match(linkRestorer, /caches\/android\/gradle-user-home\/init\.d/);
assert.match(linkRestorer, /\/Users\/divay\/Developer\/MainaV2\/scripts\/gradle-output-redirect\.init\.gradle/);
assertOrder(linkRestorer, ['local link_parent="${link_path%/*}"', 'maina_require_storage_path "$link_parent"', '[[ "$(/usr/bin/readlink "$link_path")" == "$source_path" ]]'], 'Gradle init link validation');
const prebuild = read('scripts/prebuild-android.sh');
assertOrder(prebuild, ['source "$PROJECT_DIR/scripts/maina-build-env.sh"', 'restore-external-build-links.sh" dependencies', 'expo prebuild --platform android --no-install --clean', 'restore-external-build-links.sh" android', 'verify-android-config.mjs'], 'Android prebuild');
const gradleRedirect = read('scripts/gradle-output-redirect.init.gradle');
assert.match(gradleRedirect, /MAINA_ANDROID_OUTPUT_ROOT must be supplied by the guarded Maina environment/);
assert.match(gradleRedirect, /new File\(configuredOutputRoot\)\.canonicalFile/);
assert.match(gradleRedirect, /project\.path in \[':app', ':maina-recorder'\]/);
const androidCandidate = read('scripts/build-android-release-candidate.sh');
assertOrder(androidCandidate, ['source "$PROJECT_DIR/scripts/maina-build-env.sh"', 'maina_require_storage_path "$OUTPUT_DIR"', 'maina_storage_mkdir "$OUTPUT_DIR"', ': > "$OUTPUT_DIR/build-attempted"', ':app:assembleRelease'], 'Android candidate');
assertOrder(androidCandidate, ['"${gradle_args[@]}" clean', 'restore-external-build-links.sh" android', '"${gradle_args[@]}" :app:assembleRelease'], 'Android clean/relink/build');
assert.match(androidCandidate, /"\$MAINA_RELEASE_OUTPUT_ROOT"\/android\/\*/);
const releaseVerifier = read('scripts/verify-release.sh');
assertOrder(releaseVerifier, ['source "$PROJECT_DIR/scripts/maina-build-env.sh"', 'verify-external-storage-contract.mjs', 'restore-external-build-links.sh" dependencies', 'npm run typecheck'], 'release verifier');
assertOrder(releaseVerifier, ['expo export --platform android', 'restore-external-build-links.sh" android', 'cd "$PROJECT_DIR/android"', '--project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE"'], 'release native output routing');
const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.scripts['verify:external-storage'], 'node scripts/verify-external-storage-contract.mjs');
assert.match(packageJson.scripts['verify:release-build-scripts'], /^npm run verify:external-storage && /);
assert.equal(packageJson.scripts.android, 'bash scripts/run-android-local.sh');
assert.equal(packageJson.scripts.ios, 'bash scripts/run-ios-local.sh');
assert.equal(packageJson.scripts['ios:ui-tests:configure'], 'bash scripts/configure-ios-ui-tests-guarded.sh');
const iosUiTestConfigurator = read('scripts/configure-ios-ui-tests-guarded.sh');
assert.equal(lstatSync(path.join(root, 'scripts/configure-ios-ui-tests-guarded.sh')).mode & 0o777, 0o755);
assertOrder(iosUiTestConfigurator, ['source "$PROJECT_DIR/scripts/maina-storage.sh"', "[[ \"$PROJECT_DIR\" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]", 'source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'exec "$MAINA_IOS_RUBY_BIN/ruby" scripts/configure-ios-ui-tests.rb'], 'iOS UI-test configuration wrapper');
const androidRunner = read('scripts/run-android-local.sh');
assert.equal(lstatSync(path.join(root, 'scripts/run-android-local.sh')).mode & 0o777, 0o755);
assertOrder(androidRunner, ['source "$PROJECT_DIR/scripts/maina-build-env.sh"', 'restore-external-build-links.sh" dependencies', 'restore-external-build-links.sh" android', '[[ -z "${GRADLE_OPTS:-}" ]]', 'argument in "$@"', 'expo run:android'], 'Android local runner');
assert.doesNotMatch(androidRunner, /\bexport GRADLE_OPTS=/);
assert.match(androidRunner, /\$argument" != '--no-build-cache'/);

if (kind === 'android-main') {
  const ensureGradle = read('scripts/ensure-gradle.sh');
  assertOrder(ensureGradle, ['source "$PROJECT_DIR/scripts/maina-build-env.sh"', 'export GRADLE_USER_HOME="$MAINA_GRADLE_USER_HOME"', 'maina_require_storage_path "$TEMP_ROOT"', 'maina_storage_mkdir "$TEMP_ROOT"', 'export TMPDIR="$TEMP_ROOT"', '$GRADLE_HOME/bin/gradle --version'], 'Gradle bootstrap');
  const iosRunner = read('scripts/run-ios-local.sh');
  assert.equal(lstatSync(path.join(root, 'scripts/run-ios-local.sh')).mode & 0o777, 0o755);
  assertOrder(iosRunner, ['source "$PROJECT_DIR/scripts/maina-storage.sh"', 'iOS builds are restricted', 'exit 78'], 'noncanonical iOS refusal');
} else {
  const iosEnv = read('scripts/maina-ios-env.sh');
  assertOrder(iosEnv, ['source "$MAINA_IOS_REPO_ROOT/scripts/maina-storage.sh"', 'maina_require_storage_path "$maina_external_path"', 'maina_storage_mkdir "$MAINA_IOS_BUILD_ROOT"'], 'iOS environment');
  const iosProbe = runBash(
    'set -euo pipefail; source "$1"; printf "%s\\n" "$MAINA_IOS_DERIVED_DATA_ROOT" "$MAINA_IOS_RELEASE_OUTPUT_ROOT" "$CP_HOME_DIR" "$CP_CACHE_DIR" "$TMPDIR"',
    [path.join(root, 'scripts/maina-ios-env.sh')],
  );
  assert.equal(iosProbe.status, 0, iosProbe.stderr);
  for (const [index, label] of ['DerivedData', 'iOS release output', 'CocoaPods home', 'CocoaPods cache', 'iOS TMPDIR'].entries()) {
    assertExternal(iosProbe.stdout.trim().split('\n')[index], label);
  }
  assert.equal(lstatSync(path.join(root, 'ios/Pods')).isSymbolicLink(), true);
  assert.equal(realpathSync(path.join(root, 'ios/Pods')), path.join(STORAGE_ROOT, 'dependencies/apps/ios-feasibility/Pods'));

  const dependencyInstaller = read('scripts/install-external-node-dependencies.sh');
  assert.equal(lstatSync(path.join(root, 'scripts/install-external-node-dependencies.sh')).mode & 0o777, 0o755);
  assertOrder(dependencyInstaller, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'maina_storage_mkdir "$dependency_root"', 'NODE_ENV=development npm ci', 'restore-external-build-links.sh" dependencies'], 'external npm install');
  const iosPrepare = read('scripts/prepare-ios-local.sh');
  assertOrder(iosPrepare, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'install-external-node-dependencies.sh"', 'expo prebuild --platform ios --no-install --clean', 'restore-external-build-links.sh" ios', 'pod install'], 'iOS prepare');
  assertOrder(iosPrepare, ['pod install', 'configure-ios-ui-tests-guarded.sh"'], 'iOS UI-test configuration');
  const iosRuntime = read('scripts/prepare-ios-sherpa-runtime.sh');
  assertOrder(iosRuntime, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'maina_storage_mkdir "$CACHE_ROOT"', 'mkdir -p "$VENDOR_ROOT"'], 'iOS runtime');
  const iosRenewal = read('scripts/renew-ios-personal.sh');
  assertOrder(iosRenewal, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'mkdir -p "$BACKUP_ROOT/Backups"', 'MAINA_IOS_DERIVED_DATA_ROOT/renewal-$RUN_ID', 'maina_require_storage_path "$BUILD_ROOT"', 'xcodebuild -workspace'], 'iOS renewal');
  const iosCandidate = read('scripts/build-ios-release-candidate.sh');
  assertOrder(iosCandidate, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'maina_require_storage_path "$OUTPUT_DIR"', 'maina_storage_mkdir "$OUTPUT_DIR"', ': > "$OUTPUT_DIR/build-attempted"', 'xcodebuild -workspace'], 'iOS candidate');
  assert.match(iosCandidate, /"\$MAINA_IOS_RELEASE_OUTPUT_ROOT"\/ios\/\*/);
  assert.match(iosCandidate, /"\$MAINA_IOS_DERIVED_DATA_ROOT"\/\*/);
  const staging = read('scripts/build-install-ios-staging.sh');
  assertOrder(staging, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'restore-external-build-links.sh" dependencies', 'restore-external-build-links.sh" ios', 'xcodebuild -checkFirstLaunchStatus'], 'iOS staging');
  const iosRunner = read('scripts/run-ios-local.sh');
  const xcodebuildShim = read('scripts/external-bin/xcodebuild');
  assert.equal(lstatSync(path.join(root, 'scripts/run-ios-local.sh')).mode & 0o777, 0o755);
  assert.equal(lstatSync(path.join(root, 'scripts/external-bin/xcodebuild')).mode & 0o777, 0o755);
  assertOrder(iosRunner, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'restore-external-build-links.sh" dependencies', 'restore-external-build-links.sh" ios', 'maina_storage_mkdir "$expo_output"', 'scripts/external-bin:$PATH', 'expo run:ios --output "$expo_output"'], 'iOS local runner');
  assertOrder(xcodebuildShim, ['source "$PROJECT_DIR/scripts/maina-ios-env.sh"', 'maina_require_storage_path "$derived_data"', 'maina_storage_mkdir "$derived_data"', 'exec /usr/bin/xcodebuild "$@" -derivedDataPath "$derived_data"'], 'xcodebuild shim');
  const badDerivedData = spawnSync(path.join(root, 'scripts/external-bin/xcodebuild'), ['-derivedDataPath', '/tmp', '-version'], { cwd: root, encoding: 'utf8' });
  assert.equal(badDerivedData.status, 78);
  assert.match(badDerivedData.stderr, /escapes the guarded external root/);
}

console.log(`External storage contract verified for ${kind}; protected internal outputs remain local.`);
