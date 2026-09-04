#!/usr/bin/env node

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  { platform: 'Android', path: path.join(root, 'scripts/build-android-release-candidate.sh') },
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
      MAINA_ADMIN_CAPACITY_CLEARANCE: 'approved',
      ...extraEnv,
    },
  });
}

try {
  for (const script of scripts) {
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
