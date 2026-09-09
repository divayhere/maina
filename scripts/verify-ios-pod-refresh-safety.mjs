#!/usr/bin/env node

import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
assert.equal(root, '/Users/divay/Developer/.worktrees/maina-ios-feasibility');

const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const assertOrder = (source, ordered, label) => {
  let cursor = -1;
  for (const token of ordered) {
    const next = source.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label} must preserve ordering at: ${token}`);
    cursor = next;
  }
};

function verifySources({ refresh, build, prepare }) {
  assertOrder(refresh, [
    'source "$PROJECT_DIR/scripts/maina-ios-env.sh"',
    'restore-external-build-links.sh" dependencies',
    'restore-external-build-links.sh" ios',
    '"$(pod --version)" == "1.17.0"',
    'before_lock_sha=',
    'pod install --deployment',
    'after_lock_sha=',
    '"$after_lock_sha" == "$before_lock_sha"',
    '/usr/bin/cmp -s ios/Podfile.lock ios/Pods/Manifest.lock',
    'verify-ios-pod-source-membership.rb',
  ], 'guarded pod refresh');
  assert.doesNotMatch(refresh, /pod update|--repo-update|\brm\b/);
  assertOrder(build, [
    'refresh-ios-pods-for-build-guarded.sh',
    'maina_storage_mkdir "$BUILD_ROOT"',
    'build-for-testing',
  ], 'iOS UI-test build');
  assertOrder(prepare, [
    'PROJECT_ROOT="$PROJECT_DIR" pod install',
    'verify-ios-pod-source-membership.rb',
    'configure-ios-ui-tests-guarded.sh',
  ], 'full iOS prepare');
}

const sources = {
  refresh: read('scripts/refresh-ios-pods-for-build-guarded.sh'),
  build: read('scripts/build-ios-ui-test-products-guarded.sh'),
  prepare: read('scripts/prepare-ios-local.sh'),
};
verifySources(sources);

const mutations = [
  { label: 'deployment omitted', key: 'refresh', from: 'pod install --deployment', to: 'pod install' },
  { label: 'dependency update substituted', key: 'refresh', from: 'pod install --deployment', to: 'pod update MainaRecorder' },
  { label: 'repository update enabled', key: 'refresh', from: 'pod install --deployment', to: 'pod install --deployment --repo-update' },
  { label: 'pre-refresh lock binding omitted', key: 'refresh', from: 'before_lock_sha=', to: 'before_lock_removed=' },
  { label: 'post-refresh lock equality omitted', key: 'refresh', from: '"$after_lock_sha" == "$before_lock_sha"', to: '"$after_lock_sha" != ""' },
  { label: 'membership verification omitted', key: 'refresh', from: 'verify-ios-pod-source-membership.rb', to: 'membership-check-removed' },
  { label: 'refresh omitted from UI build', key: 'build', from: 'refresh-ios-pods-for-build-guarded.sh', to: 'pod-refresh-removed' },
  { label: 'membership omitted from full prepare', key: 'prepare', from: 'verify-ios-pod-source-membership.rb', to: 'membership-check-removed' },
];
for (const mutation of mutations) {
  const changed = sources[mutation.key].replace(mutation.from, mutation.to);
  assert.notEqual(changed, sources[mutation.key], `${mutation.label} mutation must apply`);
  assert.throws(
    () => verifySources({ ...sources, [mutation.key]: changed }),
    undefined,
    `${mutation.label} must fail closed`,
  );
}

for (const script of [
  'scripts/refresh-ios-pods-for-build-guarded.sh',
  'scripts/verify-ios-pod-source-membership.rb',
]) {
  assert.equal(lstatSync(path.join(root, script)).mode & 0o777, 0o755, `${script} must be executable`);
}

const ruby = '/Users/divay/Developer/.tools/maina-ruby-3.3.9-v2/bin/ruby';
const selfTest = spawnSync(ruby, ['scripts/verify-ios-pod-source-membership.rb', '--self-test'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(selfTest.status, 0, selfTest.stderr);
assert.equal(selfTest.stdout, 'iOS pod source membership self-test PASS (6/6).\n');

console.log(`iOS pod refresh safety PASS (${mutations.length} static adversaries + 6 membership cases).`);
