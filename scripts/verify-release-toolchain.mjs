#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const EXPECTED = Object.freeze({
  nodeVersion: '24.19.0',
  nodePath: '/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
  nodeSha256: '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1',
  npmVersion: '11.19.0',
  npmCliPath: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  npmCliSha256: '8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7',
  npmManifestSha256: '09dfcf187178ce1ab3ea6194c80d3ae082ad2a86dc1269ac963f94429e718122',
  expoVersion: '57.0.18',
  expoIntegrity: 'sha512-6nax9hJPhf9dWrstliXUABTJXDNIJrfJKcCtjSxuYVs2Yf127GIhKf3wsEYSFUl+LFdRbPPTNaweJePH159wZA==',
  expoManifestSha256: '6bd6bce45f07477244f0cdb4bdc184a7f4cd4f5c68932849895efe190fe2591c',
  expoCliVersion: '57.0.20',
  expoCliIntegrity: 'sha512-ZjWz7SA5TBTyKq4+aFRUPgMFxmqHtKkDMv6d85J2UAAjdRhkNRf+B80t+rr5IFo2ywuTvyrPRBth4ei4w08olA==',
  expoCliManifestSha256: '7f2ac24b75401eab942e31d446957ccd96f29351d77322f0a78fbda87c60ee67',
  expoWrapperSha256: '644f576d9a0d2347142ae3dc0cad7f13a79171d012cf1a361e2af0880cbb85bd',
});

function fail(code) {
  process.stderr.write(code + '\n');
  process.exit(2);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code);
  return value;
}

function regularNonSymlink(file, executable, code) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    fail(code);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code);
  if (executable && (stat.mode & 0o111) === 0) fail(code);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function json(file, code) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(code);
  }
}

const [projectRootInput, nodeInput, npmInput, expoInput, planInput] = process.argv.slice(2);
if (![projectRootInput, nodeInput, npmInput, expoInput, planInput].every((value) => typeof value === 'string' && path.isAbsolute(value))) {
  fail('RELEASE_TOOLCHAIN_INPUT_INVALID');
}
const projectRoot = path.resolve(projectRootInput);
const nodeExecutable = path.resolve(nodeInput);
const npmCli = path.resolve(npmInput);
const expoWrapper = path.resolve(expoInput);
const planPath = path.resolve(planInput);
if (planPath !== path.join(projectRoot, 'release/m3-m4-0.10.70-candidate-plan.json')) fail('RELEASE_PLAN_PATH_INVALID');

regularNonSymlink(nodeExecutable, true, 'NODE_EXECUTABLE_UNAVAILABLE');
if (nodeExecutable !== EXPECTED.nodePath) fail('NODE_EXECUTABLE_PATH_DRIFT');
if (realpathSync(nodeExecutable) !== realpathSync(process.execPath)) fail('NODE_PROCESS_IDENTITY_MISMATCH');
if (process.version !== 'v' + EXPECTED.nodeVersion) fail('NODE_VERSION_DRIFT');
if (sha256(nodeExecutable) !== EXPECTED.nodeSha256) fail('NODE_EXECUTABLE_HASH_DRIFT');

if (npmCli !== EXPECTED.npmCliPath) fail('NPM_CLI_PATH_DRIFT');
const npmManifestPath = path.resolve(path.dirname(npmCli), '..', 'package.json');
if (npmManifestPath !== '/opt/homebrew/lib/node_modules/npm/package.json') fail('NPM_MANIFEST_PATH_DRIFT');
regularNonSymlink(npmCli, true, 'NPM_CLI_UNAVAILABLE');
regularNonSymlink(npmManifestPath, false, 'NPM_MANIFEST_UNAVAILABLE');
if (sha256(npmCli) !== EXPECTED.npmCliSha256) fail('NPM_CLI_HASH_DRIFT');
if (sha256(npmManifestPath) !== EXPECTED.npmManifestSha256) fail('NPM_MANIFEST_HASH_DRIFT');
const npmManifest = json(npmManifestPath, 'NPM_MANIFEST_INVALID');
if (npmManifest.name !== 'npm' || npmManifest.version !== EXPECTED.npmVersion || npmManifest.bin?.npm !== 'bin/npm-cli.js') {
  fail('NPM_IDENTITY_DRIFT');
}
const npmVersion = spawnSync(nodeExecutable, [npmCli, '--version'], { encoding: 'utf8', env: process.env });
if (npmVersion.status !== 0 || npmVersion.signal !== null || npmVersion.stderr !== ''
  || npmVersion.stdout.trim() !== EXPECTED.npmVersion || npmVersion.stdout.length > 32) fail('NPM_VERSION_DRIFT');

const canonicalExpoWrapper = path.join(projectRoot, 'node_modules/expo/bin/cli');
if (expoWrapper !== canonicalExpoWrapper) fail('EXPO_WRAPPER_PATH_DRIFT');
regularNonSymlink(expoWrapper, true, 'EXPO_WRAPPER_UNAVAILABLE');
if (sha256(expoWrapper) !== EXPECTED.expoWrapperSha256) fail('EXPO_WRAPPER_HASH_DRIFT');

const expoManifestPath = path.join(projectRoot, 'node_modules/expo/package.json');
const expoCliManifestPath = path.join(projectRoot, 'node_modules/expo/node_modules/@expo/cli/package.json');
const packageLockPath = path.join(projectRoot, 'package-lock.json');
for (const file of [expoManifestPath, expoCliManifestPath, packageLockPath, planPath]) {
  regularNonSymlink(file, false, 'RELEASE_TOOLCHAIN_FILE_UNAVAILABLE');
}
if (sha256(expoManifestPath) !== EXPECTED.expoManifestSha256) fail('EXPO_PACKAGE_MANIFEST_HASH_DRIFT');
if (sha256(expoCliManifestPath) !== EXPECTED.expoCliManifestSha256) fail('EXPO_CLI_MANIFEST_HASH_DRIFT');

const expoManifest = json(expoManifestPath, 'EXPO_PACKAGE_MANIFEST_INVALID');
const expoCliManifest = json(expoCliManifestPath, 'EXPO_CLI_MANIFEST_INVALID');
if (expoManifest.name !== 'expo' || expoManifest.version !== EXPECTED.expoVersion || expoManifest.bin?.expo !== 'bin/cli') {
  fail('EXPO_PACKAGE_IDENTITY_DRIFT');
}
if (expoCliManifest.name !== '@expo/cli' || expoCliManifest.version !== EXPECTED.expoCliVersion) {
  fail('EXPO_CLI_IDENTITY_DRIFT');
}

const lock = json(packageLockPath, 'PACKAGE_LOCK_INVALID');
const expoLock = lock.packages?.['node_modules/expo'];
const cliLock = lock.packages?.['node_modules/expo/node_modules/@expo/cli'];
if (expoLock?.version !== EXPECTED.expoVersion || expoLock?.integrity !== EXPECTED.expoIntegrity
  || expoLock?.dependencies?.['@expo/cli'] !== '^57.0.20') fail('EXPO_LOCK_IDENTITY_DRIFT');
if (cliLock?.version !== EXPECTED.expoCliVersion || cliLock?.integrity !== EXPECTED.expoCliIntegrity) {
  fail('EXPO_CLI_LOCK_IDENTITY_DRIFT');
}

const plan = json(planPath, 'RELEASE_PLAN_INVALID');
const toolchains = exactObject(plan.toolchains, [
  'nodeMajor', 'node', 'nodeExecutablePath', 'nodeExecutableSha256', 'npm', 'npmCliPath',
  'npmCliSha256', 'npmManifestSha256', 'expo', 'expoCli',
  'expoCliSha256', 'expoManifestSha256', 'expoCliManifestSha256', 'reactNative', 'android', 'ios',
], 'RELEASE_PLAN_TOOLCHAINS_NOT_CLOSED');
for (const [field, expected] of Object.entries({
  node: EXPECTED.nodeVersion,
  nodeExecutablePath: EXPECTED.nodePath,
  nodeExecutableSha256: EXPECTED.nodeSha256,
  npm: EXPECTED.npmVersion,
  npmCliPath: EXPECTED.npmCliPath,
  npmCliSha256: EXPECTED.npmCliSha256,
  npmManifestSha256: EXPECTED.npmManifestSha256,
  expo: EXPECTED.expoVersion,
  expoCli: EXPECTED.expoCliVersion,
  expoCliSha256: EXPECTED.expoWrapperSha256,
  expoManifestSha256: EXPECTED.expoManifestSha256,
  expoCliManifestSha256: EXPECTED.expoCliManifestSha256,
})) {
  if (toolchains[field] !== expected) fail('RELEASE_PLAN_TOOLCHAIN_IDENTITY_DRIFT');
}
if (toolchains.nodeMajor !== 24) fail('RELEASE_PLAN_TOOLCHAIN_IDENTITY_DRIFT');

const version = spawnSync(nodeExecutable, [expoWrapper, '--version'], { encoding: 'utf8', env: process.env });
if (version.status !== 0 || version.signal !== null || version.stderr !== ''
  || version.stdout.trim() !== EXPECTED.expoCliVersion || version.stdout.length > 32) {
  fail('EXPO_CLI_VERSION_DRIFT');
}

process.stdout.write(JSON.stringify({
  schemaVersion: 'maina.release-toolchain-verification.v1',
  node: EXPECTED.nodeVersion,
  npm: EXPECTED.npmVersion,
  expoPackage: EXPECTED.expoVersion,
  expoCli: EXPECTED.expoCliVersion,
  status: 'PASS',
}) + '\n');
