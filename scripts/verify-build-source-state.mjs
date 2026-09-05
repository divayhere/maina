#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const [platform, expectedFinalCommit] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform) || !/^[0-9a-f]{40}$/.test(expectedFinalCommit ?? '')) {
  throw new Error('Usage: verify-build-source-state.mjs <android|ios> <expected-final-commit>');
}

const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const plan = JSON.parse(readFileSync(path.join(root, 'release/m3-m4-0.10.46-candidate-plan.json'), 'utf8'));
const expected = plan.sources[platform];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

if (root !== expected.repository) throw new Error(`Canonical ${platform} repository mismatch: ${root}`);
if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Source drift: worktree is not clean.');
const branch = git('branch', '--show-current');
if (branch !== expected.branch) throw new Error(`Source drift: expected branch ${expected.branch}, found ${branch}.`);
const head = git('rev-parse', 'HEAD');
if (head !== expectedFinalCommit) throw new Error(`Source drift: expected final ${expectedFinalCommit}, found ${head}.`);
const upstreamName = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
if (upstreamName !== `origin/${expected.branch}`) throw new Error(`Source drift: unexpected upstream ${upstreamName}.`);
const upstream = git('rev-parse', '@{upstream}');
if (upstream !== head) throw new Error(`Source drift: HEAD ${head} does not equal upstream ${upstream}.`);
execFileSync('git', ['merge-base', '--is-ancestor', expected.productCommit, head], { cwd: root, stdio: 'ignore' });
const coordination = git('rev-parse', 'HEAD:coordination');
if (coordination !== plan.sources.coordinationCommit) {
  throw new Error(`Coordination drift: expected ${plan.sources.coordinationCommit}, found ${coordination}.`);
}

console.log(`${platform} build source is canonical, clean, pinned, upstream-exact, and contains the approved product commit.`);
