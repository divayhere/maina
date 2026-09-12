#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const helper = path.join(root, 'scripts/lib/release-build-attempt-guard.sh');
const temporary = mkdtempSync(path.join(os.tmpdir(), 'maina-release-build-attempt-'));
const source = 'a'.repeat(40);
const plan = 'b'.repeat(64);
const activeRelease = 'maina-m3-m4-0.10.71';
const successorRelease = 'maina-m3-m4-0.10.72';
const concurrentRelease = 'maina-m3-m4-0.10.73';
const invalidPlatformRelease = 'maina-m3-m4-0.10.74';

function command(releaseId, platform, terminal = null) {
  const terminalCommand = terminal
    ? 'maina_build_attempt_terminal ' + terminal + ' ' + (terminal === 'terminal_success' ? 'BUILD_SUCCEEDED' : 'BUILD_FAILED')
    : '';
  return [
    'source "$1"',
    'trap \'maina_build_attempt_on_exit $?\' EXIT',
    'maina_build_attempt_acquire "$2" "$3" "$4" "$5" "$6" || exit $?',
    terminalCommand,
  ].filter(Boolean).join('; ');
}

function run(releaseId, platform, terminal = null) {
  return spawnSync('/bin/bash', ['-c', command(releaseId, platform, terminal), 'guard-test', helper, temporary, releaseId, platform, source, plan], {
    encoding: 'utf8',
  });
}

try {
  assert.equal(new Set([
    `${activeRelease}/android`,
    `${activeRelease}/ios`,
    `${successorRelease}/android`,
    `${concurrentRelease}/android`,
  ]).size, 4, 'independent synthetic attempt keys must remain unique');

  const first = run(activeRelease, 'android', 'terminal_success');
  assert.equal(first.status, 0);
  const secondDifferentOutput = run(activeRelease, 'android', 'terminal_success');
  assert.equal(secondDifferentOutput.status, 75, 'same release/platform must reject independently of output directory');
  assert.equal(run(activeRelease, 'ios', 'terminal_success').status, 0);
  assert.equal(run(successorRelease, 'android', 'terminal_success').status, 0);

  for (const [releaseId, platform] of [
    [activeRelease, 'android'],
    [activeRelease, 'ios'],
    [successorRelease, 'android'],
  ]) {
    const attempt = path.join(temporary, releaseId, platform);
    assert.equal(statSync(attempt).mode & 0o777, 0o700);
    const started = JSON.parse(readFileSync(path.join(attempt, 'mutation-started.json'), 'utf8'));
    assert.deepEqual(Object.keys(started).sort(), ['planSha256', 'platform', 'releaseId', 'schemaVersion', 'sourceCommit', 'state']);
    assert.equal(started.releaseId, releaseId);
    assert.equal(started.platform, platform);
    assert.equal(started.sourceCommit, source);
    assert.equal(started.planSha256, plan);
    assert.equal(started.state, 'mutation_started');
    assert.equal(statSync(path.join(attempt, 'mutation-started.json')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(attempt, 'terminal-success.json')).mode & 0o777, 0o600);
  }

  const children = [0, 1].map(() => spawn('/bin/bash', [
    '-c',
    command(concurrentRelease, 'android'),
    'guard-test',
    helper,
    temporary,
    concurrentRelease,
    'android',
    source,
    plan,
  ], { stdio: 'ignore' }));
  const statuses = await Promise.all(children.map((child) => new Promise((resolve) => child.on('exit', resolve))));
  assert.deepEqual(statuses.sort((a, b) => a - b), [0, 75]);
  const concurrentAttempt = path.join(temporary, concurrentRelease, 'android');
  assert.equal(statSync(concurrentAttempt).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(concurrentAttempt, 'reconciliation-required.json')).mode & 0o777, 0o600);

  assert.equal(run('../escape', 'android').status, 2);
  assert.equal(run(invalidPlatformRelease, 'windows').status, 2);
  const helperSource = readFileSync(helper, 'utf8');
  assert.doesNotMatch(helperSource, /MAINA_RELEASE_OUTPUT_DIR/);
  console.log('Release build attempt guard verified: distinct-output replay, platform separation, successor identity, concurrency, retained terminal state, and fail-closed inputs.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
