#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  'health)',
];

for (const fragment of requiredFragments) {
  if (!source.includes(fragment)) {
    throw new Error(`M0 replay harness is missing required safety fragment: ${fragment}`);
  }
}

if (source.includes('--terminate-existing')) {
  throw new Error('M0 replay harness must never terminate an active installed app or test.');
}

console.log('M0 replay harness static safety verification passed.');
