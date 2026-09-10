#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const storageGuard = '/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh';
const guarded = spawnSync(storageGuard, [], { encoding: 'utf8' });
assert.equal(guarded.status, 0, 'The canonical external-storage guard must pass before test output is created.');
assert.equal(guarded.stdout, '/Volumes/DivaySSD/MainaBuild\n');
const temporaryParent = path.join(guarded.stdout.trim(), 'scratch/apps/tests/release-build-safety');
mkdirSync(temporaryParent, { recursive: true });
const temporary = mkdtempSync(path.join(temporaryParent, 'attempt-'));
const scripts = [
  { platform: 'iOS', path: path.join(root, 'scripts/build-ios-release-candidate.sh') },
].filter((entry) => existsSync(entry.path));

function invoke(script, outputDir, extraEnv = {}) {
  return spawnSync('/bin/bash', [script.path], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAINA_EXPECTED_FINAL_COMMIT: '0'.repeat(40),
      MAINA_RELEASE_OUTPUT_DIR: outputDir,
      MAINA_RELEASE_OUTPUT_ROOT: temporary,
      MAINA_IOS_RELEASE_OUTPUT_ROOT: temporary,
      MAINA_IOS_DERIVED_DATA_ROOT: path.join(temporary, 'derived-data'),
      MAINA_ADMIN_CAPACITY_CLEARANCE: 'approved',
      ...extraEnv,
    },
  });
}

try {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['android', 'android:prepare', 'android:build-candidate', 'android:install-preserving']) {
    assert.equal(Object.hasOwn(manifest.scripts, name), false, `iOS branch must not publish ${name}.`);
  }
  const wrongWorktreeAndroidScript = path.join(root, 'scripts/build-android-release-candidate.sh');
  const wrongWorktreeAndroidSource = readFileSync(wrongWorktreeAndroidScript, 'utf8');
  const rootGuardIndex = wrongWorktreeAndroidSource.indexOf('[[ "$(cd "$PROJECT_DIR" && pwd -P)" == "/Users/divay/Developer/MainaV2" ]]');
  const environmentSourceIndex = wrongWorktreeAndroidSource.indexOf('source "$PROJECT_DIR/scripts/maina-build-env.sh"');
  const restoreLinksIndex = wrongWorktreeAndroidSource.indexOf('restore-external-build-links.sh" dependencies');
  assert.ok(rootGuardIndex >= 0 && rootGuardIndex < environmentSourceIndex && environmentSourceIndex < restoreLinksIndex,
    'Wrong-worktree gate must precede mutable environment and dependency-link helpers.');
  const wrongWorktreeOutput = path.join(temporary, 'wrong-worktree-android');
  const wrongWorktreeBuildOutput = path.join(temporary, 'wrong-worktree-android-build-output');
  const wrongWorktreeTempOutput = path.join(temporary, 'wrong-worktree-android-temp-output');
  const wrongWorktreeAndroid = spawnSync('/bin/bash', [wrongWorktreeAndroidScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAINA_RELEASE_OUTPUT_DIR: wrongWorktreeOutput,
      MAINA_ANDROID_OUTPUT_ROOT: wrongWorktreeBuildOutput,
      MAINA_ANDROID_TEMP_ROOT: wrongWorktreeTempOutput,
    },
  });
  assert.equal(wrongWorktreeAndroid.status, 78);
  assert.equal(wrongWorktreeAndroid.stderr, 'Android release builder is unavailable from this noncanonical worktree.\n');
  assert.equal(wrongWorktreeAndroid.stdout, '');
  assert.equal(existsSync(wrongWorktreeOutput), false, 'Wrong-worktree rejection must precede all output and helper writes.');
  assert.equal(existsSync(wrongWorktreeBuildOutput), false, 'Wrong-worktree rejection must precede build-environment directories.');
  assert.equal(existsSync(wrongWorktreeTempOutput), false, 'Wrong-worktree rejection must precede temporary build directories.');

  for (const script of scripts) {
    const scriptSource = readFileSync(script.path, 'utf8');
    assert.match(scriptSource, /\/usr\/bin\/grep -E -i -q/, `${script.platform} must use the host-stable post-build failure scanner.`);
    assert.doesNotMatch(scriptSource, /\brg -i -q/, `${script.platform} must not silently depend on ambient ripgrep after mutation.`);
    assert.match(scriptSource, /scripts\/verify-release-toolchain\.mjs/);
    assert.match(scriptSource, /NPM_CLI="\$\{MAINA_NPM_CLI:-\/opt\/homebrew\/lib\/node_modules\/npm\/bin\/npm-cli\.js\}"/);
    assert.match(scriptSource, /scripts\/lib\/release-build-attempt-guard\.sh/);
    assert.match(scriptSource, /artifacts\/apps\/release-build-attempts/);
    assert.ok(scriptSource.indexOf('verify-release-toolchain.mjs') < scriptSource.indexOf('maina_build_attempt_acquire'));
    assert.ok(scriptSource.indexOf('maina_build_attempt_acquire') < scriptSource.indexOf('maina_storage_mkdir "$OUTPUT_DIR"'));
    assert.ok(scriptSource.indexOf('maina_build_attempt_acquire') < scriptSource.indexOf(': > "$OUTPUT_DIR/build-attempted"'));

    const substitutedNpmOutput = path.join(temporary, script.platform.toLowerCase(), `substituted-npm-${randomUUID()}`);
    const substitutedNpm = invoke(script, substitutedNpmOutput, {
      MAINA_NPM_CLI: path.join(temporary, 'not-the-pinned-npm-cli.js'),
    });
    assert.equal(substitutedNpm.status, 2, `${script.platform} must reject a noncanonical selected npm CLI before a build attempt.`);
    assert.match(substitutedNpm.stderr, /NPM_CLI_PATH_DRIFT/);
    assert.equal(existsSync(substitutedNpmOutput), false, `${script.platform} npm substitution rejection must not create evidence.`);

    if (script.platform === 'Android') {
      const prebuildSource = readFileSync(path.join(root, 'scripts/prebuild-android.sh'), 'utf8');
      assert.match(scriptSource, /EXPO_CLI="\$\{MAINA_EXPO_CLI:-\$PROJECT_DIR\/node_modules\/expo\/bin\/cli\}"/);
      assert.match(scriptSource, /export PATH="\$NODE_BIN:/);
      assert.match(prebuildSource, /"\$NODE_BIN\/node" "\$EXPO_CLI" prebuild --platform android --no-install --clean/);
      assert.doesNotMatch(prebuildSource, /\bnpx\s+expo\b/);

      const missingExpoOutput = path.join(temporary, 'android', `missing-expo-${randomUUID()}`);
      const missingExpo = invoke(script, missingExpoOutput, {
        MAINA_NODE_BIN: '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin',
        MAINA_EXPO_CLI: path.join(temporary, 'missing-expo-cli'),
      });
      assert.equal(missingExpo.status, 2, 'Android must reject an unavailable exact Expo CLI before a build attempt.');
      assert.match(missingExpo.stderr, /EXPO_WRAPPER_PATH_DRIFT/);
      assert.equal(existsSync(missingExpoOutput), false, 'Android missing-Expo rejection must not create its evidence root.');
    }

    if (script.platform === 'iOS') {
      const prepareSource = readFileSync(path.join(root, 'scripts/prepare-ios-local.sh'), 'utf8');
      assert.match(prepareSource, /"\$NODE_EXECUTABLE" "\$EXPO_CLI" prebuild --platform ios --no-install --clean/);
      assert.match(prepareSource, /scripts\/verify-release-toolchain\.mjs/);
      assert.doesNotMatch(prepareSource, /\bnpx\s+expo\b/);
    }

    const internal = path.join('/Users/divay/.cache/maina-build-v2/outputs', `storage-contract-must-not-write-${randomUUID()}`);
    const internalResult = invoke(script, internal);
    assert.equal(internalResult.status, 78, `${script.platform} must reject internal evidence output without fallback.`);
    assert.match(internalResult.stderr, /escapes the guarded external root/);
    assert.equal(existsSync(internal), false, `${script.platform} must not write under protected internal outputs.`);

    const externalOutside = path.join(temporary, `outside-${script.platform.toLowerCase()}-${randomUUID()}`);
    const externalOutsideResult = invoke(script, externalOutside);
    assert.equal(externalOutsideResult.status, 78, `${script.platform} must reject external output outside its configured artifact subtree.`);
    assert.match(externalOutsideResult.stderr, /must stay under the guarded/);
    assert.equal(existsSync(externalOutside), false, `${script.platform} must reject an out-of-subtree path before writing it.`);

    if (script.platform === 'iOS') {
      const invalidDerivedOutput = path.join(temporary, 'ios', `invalid-derived-${randomUUID()}`);
      const invalidDerived = invoke(script, invalidDerivedOutput, {
        MAINA_IOS_CANDIDATE_DERIVED_DATA: path.join(temporary, `not-derived-data-${randomUUID()}`),
      });
      assert.equal(invalidDerived.status, 78, 'iOS must reject candidate DerivedData outside its configured DerivedData subtree.');
      assert.match(invalidDerived.stderr, /DerivedData must stay under the guarded/);
      assert.equal(existsSync(invalidDerivedOutput), false, 'iOS must reject invalid DerivedData before writing evidence.');
    }

    const platformRoot = path.join(temporary, script.platform.toLowerCase());
    const stale = path.join(platformRoot, 'stale');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'prior-build.log'), 'prior evidence');
    const staleResult = invoke(script, stale);
    assert.equal(staleResult.status, 73, `${script.platform} must reject a non-fresh evidence directory.`);
    assert.match(staleResult.stderr, /not fresh/);
    assert.equal(existsSync(path.join(stale, 'build-attempted')), false, `${script.platform} must reject stale evidence before writing its attempt marker.`);

    const attempted = path.join(platformRoot, 'attempted');
    mkdirSync(attempted);
    writeFileSync(path.join(attempted, 'build-attempted'), '');
    const attemptedResult = invoke(script, attempted);
    assert.equal(attemptedResult.status, 75, `${script.platform} must retain no-retry marker behavior.`);
    assert.match(attemptedResult.stderr, /retry is forbidden/);
  }
  console.log(`Release evidence-root safety verified for ${scripts.map((entry) => entry.platform).join(' and ')}.`);
} finally {
  assert.ok(temporary.startsWith(`${temporaryParent}/attempt-`), 'Refusing broad release-test cleanup.');
  rmSync(temporary, { recursive: true, force: true });
}
