#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'maina-release-build-safety-'));
const scripts = [
  { platform: 'Android', path: path.join(root, 'scripts/build-android-release-candidate.sh') },
  { platform: 'iOS', path: path.join(root, 'scripts/build-ios-release-candidate.sh') },
].filter((entry) => existsSync(entry.path));

function invoke(script, outputDir) {
  return spawnSync('/bin/bash', [script.path], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAINA_EXPECTED_FINAL_COMMIT: '0'.repeat(40),
      MAINA_RELEASE_OUTPUT_DIR: outputDir,
      MAINA_ADMIN_CAPACITY_CLEARANCE: 'approved',
    },
  });
}

try {
  for (const script of scripts) {
    const stale = path.join(temporary, `${script.platform.toLowerCase()}-stale`);
    mkdirSync(stale);
    writeFileSync(path.join(stale, 'prior-build.log'), 'prior evidence');
    const staleResult = invoke(script, stale);
    assert.equal(staleResult.status, 73, `${script.platform} must reject a non-fresh evidence directory.`);
    assert.match(staleResult.stderr, /not fresh/);
    assert.equal(existsSync(path.join(stale, 'build-attempted')), false, `${script.platform} must reject stale evidence before writing its attempt marker.`);

    const attempted = path.join(temporary, `${script.platform.toLowerCase()}-attempted`);
    mkdirSync(attempted);
    writeFileSync(path.join(attempted, 'build-attempted'), '');
    const attemptedResult = invoke(script, attempted);
    assert.equal(attemptedResult.status, 75, `${script.platform} must retain no-retry marker behavior.`);
    assert.match(attemptedResult.stderr, /retry is forbidden/);
  }
  console.log(`Release evidence-root safety verified for ${scripts.map((entry) => entry.platform).join(' and ')}.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
