#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const runnerPath = path.join(project, 'scripts', 'verify-android-source-native.sh');
const runner = readFileSync(runnerPath, 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function ordered(source, tokens) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    invariant(next > cursor, `Android source runner ordering/invariant missing: ${token}`);
    cursor = next;
  }
}

function validate(source) {
  invariant(source.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n'), 'Runner must be strict Bash.');
  ordered(source, [
    'source "$PROJECT_DIR/scripts/maina-build-env.sh"',
    '"$MAINA_NODE_BIN/node" "$PROJECT_DIR/scripts/verify-external-storage-contract.mjs"',
    '"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies',
    '"$PROJECT_DIR/scripts/restore-external-build-links.sh" android',
    '"$MAINA_NODE_BIN/node" "$PROJECT_DIR/coordination/scripts/verify.mjs"',
    '"$PROJECT_DIR/scripts/ensure-gradle.sh"',
    'cd "$PROJECT_DIR/android"',
    '"$MAINA_GRADLE_HOME/bin/gradle"',
    '--gradle-user-home "$MAINA_GRADLE_USER_HOME"',
    '--project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE"',
    '-PreactNativeArchitectures="$MAINA_ANDROID_ABI"',
    ':maina-recorder:testDebugUnitTest',
    ':maina-recorder:compileDebugKotlin',
    ':app:compileDebugKotlin',
    '--console=plain',
    '--no-daemon',
  ]);

  for (const forbidden of [
    /\badb\b/i,
    /\bexpo\b/i,
    /\b(?:install|uninstall|assemble|package|bundle|clean)\w*\b/i,
    /:\w*(?:Release|Device)\w*/,
    /verify-toolchain\.sh/,
  ]) {
    invariant(!forbidden.test(source), `Runner contains forbidden operation: ${forbidden}`);
  }

  const taskLines = source.split('\n')
    .map((line) => line.trim().replace(/ \\$/, ''))
    .filter((line) => line.startsWith(':'));
  invariant(JSON.stringify(taskLines) === JSON.stringify([
    ':maina-recorder:testDebugUnitTest',
    ':maina-recorder:compileDebugKotlin',
    ':app:compileDebugKotlin',
  ]), `Runner task set is not exact: ${JSON.stringify(taskLines)}`);
}

validate(runner);
invariant(
  packageJson.scripts?.['verify:android-source-native'] === 'bash scripts/verify-android-source-native.sh',
  'package.json must expose the exact guarded Android source runner.',
);
invariant(
  packageJson.scripts?.['verify:release-build-scripts']?.endsWith(
    '&& node scripts/verify-android-source-native-script.mjs',
  ),
  'The established release-script safety route must include the Android source-runner contract.',
);

const adversarial = [
  runner.replace('source "$PROJECT_DIR/scripts/maina-build-env.sh"', '# guard removed'),
  runner.replace('"$PROJECT_DIR/scripts/restore-external-build-links.sh" android', '# Android link restore removed'),
  runner.replace('"$MAINA_GRADLE_HOME/bin/gradle"', 'adb devices\n"$MAINA_GRADLE_HOME/bin/gradle"'),
  runner.replace(':app:compileDebugKotlin', ':app:assembleDebug'),
  runner.replace('--project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE"', '--project-cache-dir /tmp/gradle'),
  runner.replace(
    '"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies\n"$PROJECT_DIR/scripts/restore-external-build-links.sh" android',
    '"$PROJECT_DIR/scripts/restore-external-build-links.sh" android\n"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies',
  ),
];
for (const [index, candidate] of adversarial.entries()) {
  let rejected = false;
  try {
    validate(candidate);
  } catch {
    rejected = true;
  }
  invariant(rejected, `Adversarial runner mutation ${index + 1} was not rejected.`);
}

console.log('Android guarded source-test runner contract verified; 6 adversarial mutations rejected.');
