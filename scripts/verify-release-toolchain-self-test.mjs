#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const nodeExecutable = '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node';
const npmCli = '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js';
const helper = path.join(root, 'scripts/verify-release-toolchain.mjs');
const guard = '/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh';
const guarded = spawnSync(guard, [], { encoding: 'utf8' });
assert.equal(guarded.status, 0);
assert.equal(guarded.stdout, '/Volumes/DivaySSD/MainaBuild\n');
const parent = path.join(guarded.stdout.trim(), 'scratch/apps/tests/release-toolchain');
mkdirSync(parent, { recursive: true });
const temporary = mkdtempSync(path.join(parent, 'attempt-'));
const fixture = path.join(temporary, 'project');

function invoke(runtime, project, suppliedNode, suppliedNpm, suppliedExpo) {
  return spawnSync(runtime, [helper, project, suppliedNode, suppliedNpm, suppliedExpo,
    path.join(project, 'release/m3-m4-0.10.69-candidate-plan.json')], { encoding: 'utf8' });
}

try {
  const exact = invoke(nodeExecutable, root, nodeExecutable, npmCli, path.join(root, 'node_modules/expo/bin/cli'));
  assert.equal(exact.status, 0);
  assert.deepEqual(JSON.parse(exact.stdout), {
    schemaVersion: 'maina.release-toolchain-verification.v1', node: '24.19.0', npm: '11.19.0',
    expoPackage: '57.0.18', expoCli: '57.0.20', status: 'PASS',
  });

  for (const directory of ['node_modules/expo/bin', 'node_modules/expo/node_modules/@expo/cli', 'release']) {
    mkdirSync(path.join(fixture, directory), { recursive: true });
  }
  for (const relative of [
    'node_modules/expo/bin/cli', 'node_modules/expo/package.json',
    'node_modules/expo/node_modules/@expo/cli/package.json', 'package-lock.json',
    'release/m3-m4-0.10.69-candidate-plan.json',
  ]) copyFileSync(path.join(root, relative), path.join(fixture, relative));
  chmodSync(path.join(fixture, 'node_modules/expo/bin/cli'), 0o755);

  const outsideWrapper = path.join(temporary, 'copied-expo-cli');
  copyFileSync(path.join(fixture, 'node_modules/expo/bin/cli'), outsideWrapper);
  chmodSync(outsideWrapper, 0o755);
  const copiedWrapper = invoke(nodeExecutable, fixture, nodeExecutable, npmCli, outsideWrapper);
  assert.equal(copiedWrapper.status, 2);
  assert.equal(copiedWrapper.stderr, 'EXPO_WRAPPER_PATH_DRIFT\n');

  const cliManifest = path.join(fixture, 'node_modules/expo/node_modules/@expo/cli/package.json');
  const originalCliManifest = readFileSync(cliManifest);
  writeFileSync(cliManifest, Buffer.concat([originalCliManifest, Buffer.from('\n')]));
  const nestedDrift = invoke(nodeExecutable, fixture, nodeExecutable, npmCli, path.join(fixture, 'node_modules/expo/bin/cli'));
  assert.equal(nestedDrift.status, 2);
  assert.equal(nestedDrift.stderr, 'EXPO_CLI_MANIFEST_HASH_DRIFT\n');
  writeFileSync(cliManifest, originalCliManifest);

  const planPath = path.join(fixture, 'release/m3-m4-0.10.69-candidate-plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.toolchains.unexpected = true;
  writeFileSync(planPath, JSON.stringify(plan));
  const openPlan = invoke(nodeExecutable, fixture, nodeExecutable, npmCli, path.join(fixture, 'node_modules/expo/bin/cli'));
  assert.equal(openPlan.status, 2);
  assert.equal(openPlan.stderr, 'RELEASE_PLAN_TOOLCHAINS_NOT_CLOSED\n');

  const shimDirectory = path.join(temporary, 'shim');
  mkdirSync(shimDirectory);
  const shim = path.join(shimDirectory, 'node');
  writeFileSync(shim, '#!/bin/bash\nexec /Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node "$@"\n');
  chmodSync(shim, 0o755);
  const delegatedNode = invoke(shim, root, shim, npmCli, path.join(root, 'node_modules/expo/bin/cli'));
  assert.equal(delegatedNode.status, 2);
  assert.equal(delegatedNode.stderr, 'NODE_EXECUTABLE_PATH_DRIFT\n');

  const substitutedNpmPath = path.join(temporary, 'npm-cli.js');
  copyFileSync(npmCli, substitutedNpmPath);
  chmodSync(substitutedNpmPath, 0o755);
  const substitutedNpm = invoke(nodeExecutable, root, nodeExecutable, substitutedNpmPath, path.join(root, 'node_modules/expo/bin/cli'));
  assert.equal(substitutedNpm.status, 2);
  assert.equal(substitutedNpm.stderr, 'NPM_CLI_PATH_DRIFT\n');

  console.log('Exact release toolchain verified: Node identity, Expo package/CLI split, canonical wrapper, nested manifest, closed plan, and substitution rejection.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
