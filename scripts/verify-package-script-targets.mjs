#!/usr/bin/env node

import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const INTERPRETERS = new Set(['node', 'bash', 'ruby', 'python3']);
const PLAIN_TOKEN = /^[A-Za-z0-9_@+./:=,-]+$/u;
const EXTERNAL_SEGMENTS = new Set([
  'expo lint', 'expo start', 'expo start --web',
  'npm run lint', 'npm run test', 'npm run typecheck', 'npm run verify:external-storage',
  'npx expo-doctor@latest', 'patch-package', 'tsc --noEmit', 'vitest run',
]);

function validateExternalCommand(tokens, name) {
  const command = tokens.join(' ');
  assert.ok(EXTERNAL_SEGMENTS.has(command), 'package script ' + name + ' external command shape is not allow-listed');
}

function canonicalLocalTarget(raw, name) {
  assert.ok(!path.posix.isAbsolute(raw), 'package script ' + name + ' local target must be relative');
  const withoutDot = raw.startsWith('./') ? raw.slice(2) : raw;
  const normalized = path.posix.normalize(withoutDot);
  assert.equal(normalized, withoutDot, 'package script ' + name + ' contains a non-canonical local target');
  assert.ok(normalized.startsWith('scripts/') || normalized.startsWith('coordination/scripts/'),
    'package script ' + name + ' local target escapes owned script roots');
  return normalized;
}

function isLocalTarget(token) {
  return token.startsWith('scripts/') || token.startsWith('./scripts/')
    || token.startsWith('coordination/scripts/') || token.startsWith('./coordination/scripts/');
}

export function collectLocalScriptTargets(scripts) {
  assert.ok(scripts && typeof scripts === 'object' && !Array.isArray(scripts), 'package scripts must be an object');
  const targets = [];
  for (const [name, command] of Object.entries(scripts)) {
    assert.equal(typeof command, 'string', 'package script ' + name + ' must be a string');
    assert.ok(command.length > 0 && command.length <= 4096 && !/[\n\r`$()\\;|<>]/u.test(command),
      'package script ' + name + ' uses unsupported shell syntax');
    const segments = command.split(/\s+&&\s+/u);
    assert.ok(segments.length > 0 && segments.every(Boolean), 'package script ' + name + ' has an invalid command list');
    for (const segment of segments) {
      const tokens = segment.trim().split(/\s+/u);
      assert.ok(tokens.every((token) => PLAIN_TOKEN.test(token)), 'package script ' + name + ' has an unsupported token');
      const executable = tokens[0];
      if (INTERPRETERS.has(executable)) {
        const target = tokens[1];
        assert.ok(target && isLocalTarget(target), 'package script ' + name + ' interpreter target is unsupported');
        targets.push({ name, relative: canonicalLocalTarget(target, name) });
      } else if (isLocalTarget(executable)) {
        targets.push({ name, relative: canonicalLocalTarget(executable, name) });
      } else {
        validateExternalCommand(tokens, name);
      }
    }
  }
  return targets;
}

const fixtureTargets = collectLocalScriptTargets({
  one: 'node ./scripts/one.mjs',
  two: 'npm run test && bash scripts/two.sh --flag',
  three: 'ruby scripts/three.rb && node scripts/four.mjs',
  four: 'python3 coordination/scripts/four.py',
  five: 'scripts/five.sh --flag',
  external: 'expo start',
});
assert.deepEqual(fixtureTargets, [
  { name: 'one', relative: 'scripts/one.mjs' },
  { name: 'two', relative: 'scripts/two.sh' },
  { name: 'three', relative: 'scripts/three.rb' },
  { name: 'three', relative: 'scripts/four.mjs' },
  { name: 'four', relative: 'coordination/scripts/four.py' },
  { name: 'five', relative: 'scripts/five.sh' },
]);
for (const scripts of [
  { traversal: 'node scripts/../private.mjs' },
  { missingTarget: 'node' },
  { unknownInterpreter: 'perl scripts/missing.pl' },
  { interpreterOption: 'node --require scripts/existing-hook.mjs scripts/missing-main.mjs' },
  { externalLocalTarget: 'npx tsx scripts/missing.ts' },
  { normalizedExternalLocalTarget: 'npx tsx ././scripts/missing.ts' },
  { npmExecLocalTarget: 'npm exec tsx missing.ts' },
  { unapprovedNpmScript: 'npm run does-not-exist' },
  { shellPipe: 'node scripts/one.mjs | node scripts/two.mjs' },
  { shellOr: 'node scripts/one.mjs || node scripts/two.mjs' },
  { shellSequence: 'node scripts/one.mjs; node scripts/two.mjs' },
]) assert.throws(() => collectLocalScriptTargets(scripts));

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const targets = collectLocalScriptTargets(manifest.scripts);
assert.ok(targets.length > 0, 'package scripts must expose local verification targets');
for (const { name, relative } of targets) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    assert.fail('package script ' + name + ' references missing local target ' + relative);
  }
  assert.equal(stat.isSymbolicLink(), false, 'package script ' + name + ' target must not be a symlink');
  assert.equal(stat.isFile(), true, 'package script ' + name + ' target must be a regular file');
}
console.log('Package-script target integrity verified for ' + targets.length + ' local references.');
