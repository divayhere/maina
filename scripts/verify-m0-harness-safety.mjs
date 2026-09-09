#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const absolute = (relative) => path.join(root, relative);
const read = (relative) => fs.readFileSync(absolute(relative), 'utf8');
const readIfPresent = (relative) => fs.existsSync(absolute(relative)) ? read(relative) : null;

const replayPath = absolute('scripts/m0-replay-harness.sh');
const replay = read('scripts/m0-replay-harness.sh');
const stop = readIfPresent('scripts/stop-dual-device-soak.sh');
const ui = readIfPresent('ios-tests/MainaUITests.swift');
const adbTarget = readIfPresent('scripts/adb-target.sh');
const iosUiConfigurator = readIfPresent('scripts/configure-ios-ui-tests.rb');
const iosUiBuild = readIfPresent('scripts/build-ios-ui-test-products-guarded.sh');
const iosUiRun = readIfPresent('scripts/run-ios-ui-tests-guarded.sh');
const iosDirectUiRun = readIfPresent('scripts/run-ios-xcuitest-direct.py');

execFileSync('/bin/bash', ['-n', replayPath], { stdio: 'inherit' });

for (const [label, body, token] of [
  ['replay harness', replay, '--terminate-existing'],
  ['replay harness', replay, 'force-stop'],
  ['soak stop', stop ?? '', 'debugserver'],
  ['soak stop', stop ?? '', 'process detach'],
  ['soak stop', stop ?? '', '--terminate-existing'],
]) {
  if (body.includes(token)) throw new Error(`${label} contains forbidden active-test token: ${token}`);
}

for (const token of ['monitor_healthy', 'kill -0', 'monitors_healthy', 'health)']) {
  if (!replay.includes(token)) throw new Error(`Replay harness is missing safety token: ${token}`);
}

if (adbTarget) {
  const androidHarness = `${replay}\n${adbTarget}`;
  for (const token of ['._adb-tls-connect._tcp', 'getprop ro.serialno', 'getprop ro.product.model']) {
    if (!androidHarness.includes(token)) throw new Error(`Wireless Android target safety is missing: ${token}`);
  }
}

if ((stop == null) !== (ui == null)) {
  throw new Error('iOS attach-only stop harness and UI test must be present together.');
}
if (stop && ui) {
  for (const token of ['test-without-building', 'MAINA_UI_ATTACH_RUNNING=1', 'testStopExistingRecording']) {
    if (!stop.includes(token)) throw new Error(`Soak stop is missing attach-only UI-test token: ${token}`);
  }
  for (const token of ['attachesToRunningApp', 'app.activate()', 'testStopExistingRecording']) {
    if (!ui.includes(token)) throw new Error(`UI test is missing attach-only behavior: ${token}`);
  }
  const attachBranch = ui.slice(ui.indexOf('if attachesToRunningApp'), ui.indexOf('app.launch()'));
  if (!attachBranch.includes('return')) throw new Error('Attach-only setup does not return before app.launch().');

  for (const token of [
    'authorizeMicrophoneIfPresented()',
    'XCUIApplication(bundleIdentifier: "com.apple.springboard")',
    'alert.staticTexts["“Maina” would like to access the Microphone."]',
    'alert.buttons["Allow"]',
    'waitForDurablePostRecordingState(timeout:',
    'let home = app.staticTexts["RECENT"]',
    'let detailNotes = app.staticTexts["Notes"]',
    'label == %@", "Transcript"',
    'label == %@", "To-dos"',
    'home.exists || (detailNotes.exists && detailTranscript.exists && detailTodos.exists)',
  ]) {
    if (!ui.includes(token)) throw new Error(`iOS UI test is missing a bounded recording-lifecycle oracle: ${token}`);
  }
  if (ui.includes("label CONTAINS[c] 'Recent' OR label CONTAINS[c] 'recording'")) {
    throw new Error('iOS UI test still uses the stale post-recording substring oracle.');
  }
  const permissionHelper = ui.slice(
    ui.indexOf('private func authorizeMicrophoneIfPresented()'),
    ui.indexOf('private func waitForDurablePostRecordingState'),
  );
  if (permissionHelper.indexOf('“Maina” would like to access the Microphone.') > permissionHelper.indexOf('alert.buttons["Allow"]')) {
    throw new Error('iOS UI test can accept an Allow action before proving the exact microphone alert.');
  }
  const permissionGuardStart = permissionHelper.indexOf(
    'guard alert.staticTexts["“Maina” would like to access the Microphone."].exists else',
  );
  const allowLookupStart = permissionHelper.indexOf('let allow = alert.buttons["Allow"]');
  if (permissionGuardStart < 0 || allowLookupStart <= permissionGuardStart) {
    throw new Error('iOS UI test does not guard the exact microphone prompt before resolving Allow.');
  }
  const exactPermissionGuard = permissionHelper.slice(permissionGuardStart, allowLookupStart);
  if (!exactPermissionGuard.includes('XCTFail(') || !exactPermissionGuard.includes('return')) {
    throw new Error('iOS UI test does not fail closed before resolving the microphone Allow action.');
  }
  const allowGuardStart = permissionHelper.indexOf('guard allow.exists else');
  const allowTapStart = permissionHelper.indexOf('allow.tap()');
  if (allowGuardStart <= allowLookupStart || allowTapStart <= allowGuardStart) {
    throw new Error('iOS UI test does not guard the microphone Allow action before tapping it.');
  }
  const allowGuard = permissionHelper.slice(allowGuardStart, allowTapStart);
  if (!allowGuard.includes('XCTFail(') || !allowGuard.includes('return')) {
    throw new Error('iOS UI test can tap a missing or unproven microphone Allow action.');
  }
}

if (iosUiConfigurator) {
  const qualificationRunnerId = 'com.divay.maina.staging.qualify1048.uitests';
  if (!iosUiConfigurator.includes(`configuration.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "${qualificationRunnerId}"`)) {
    throw new Error(`iOS UI-test configurator is not bound to ${qualificationRunnerId}.xctrunner`);
  }
}

if (iosUiBuild) {
  if (!iosUiBuild.includes('export SENTRY_DISABLE_AUTO_UPLOAD=true')) {
    throw new Error('iOS UI-test build must disable qualification-only Sentry uploads.');
  }
  if (!iosUiBuild.includes("-destination 'generic/platform=iOS'")) {
    throw new Error('iOS UI-test products must build against the generic iOS destination.');
  }
}

if (iosUiRun) {
  for (const token of [
    'source "$PROJECT_DIR/scripts/maina-ios-env.sh"',
    'maina_require_storage_path "$PRODUCTS_ROOT"',
    'maina_require_storage_path "$RESULT_ROOT"',
    'test-without-building',
    '00008120-001E146611E2601E',
    'testNavigationAudit',
    'testShortRecordingLifecycle',
    'testRapidPauseResumeFirstTap',
    'testPausedStatePersistsUntilResume',
    'testBackgroundForegroundRecording',
    'testDiscardRecordingLifecycle',
    'testProcessDeathRecovery',
    'testLongRecordingWithBackgroundAndPauses',
    '-resultBundlePath',
  ]) {
    if (!iosUiRun.includes(token)) throw new Error(`iOS UI-test runner is missing bounded token: ${token}`);
  }
  for (const token of ['testCloudPairingWithExternalApproval', 'testStopExistingRecording', 'testKeepInterruptedRecording']) {
    if (iosUiRun.includes(token)) throw new Error(`iOS UI-test runner exposes unsafe or state-dependent test: ${token}`);
  }
  if (!iosUiRun.includes('if [[ -e "$RESULT_ROOT" ]]')) {
    throw new Error('iOS UI-test runner does not reject a reused result root.');
  }
  if (!iosUiRun.includes('XCTESTRUN_CANDIDATES=("$PRODUCTS_ROOT"/Build/Products/MainaUITests_iphoneos*-arm64.xctestrun)')) {
    throw new Error('iOS UI-test runner is not bound to exactly one physical-device xctestrun product.');
  }
}

if (iosDirectUiRun) {
  for (const token of [
    '00008120-001E146611E2601E',
    'com.divay.maina.staging.qualify1048.uitests.xctrunner',
    'com.divay.maina.staging',
    'MainaUITests/testNavigationAudit',
    'MainaUITests/testShortRecordingLifecycle',
    'MainaUITests/testRapidPauseResumeFirstTap',
    'MainaUITests/testPausedStatePersistsUntilResume',
    'MainaUITests/testBackgroundForegroundRecording',
    'MainaUITests/testDiscardRecordingLifecycle',
    'MainaUITests/testProcessDeathRecovery',
    'MainaUITests/testLongRecordingWithBackgroundAndPauses',
    'config.tests_to_run = selected',
    'os.O_EXCL',
    'hashlib.sha256(attachment.data).hexdigest()',
    'DEVICE_TRANSPORT_UNAVAILABLE',
    'TEST_CONFIGURATION_FAILED',
    'failureStage',
  ]) {
    if (!iosDirectUiRun.includes(token)) throw new Error(`Direct iOS UI-test runner is missing bounded token: ${token}`);
  }
  for (const token of ['testCloudPairingWithExternalApproval', 'testStopExistingRecording', 'testKeepInterruptedRecording']) {
    if (iosDirectUiRun.includes(token)) throw new Error(`Direct iOS UI-test runner exposes unsafe or state-dependent test: ${token}`);
  }
}

console.log('M0 harness safety verification passed.');
