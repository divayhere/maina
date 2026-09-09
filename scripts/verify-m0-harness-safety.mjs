#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const generatedUi = readIfPresent('ios/MainaUITests/MainaUITests.swift');
const adbTarget = readIfPresent('scripts/adb-target.sh');
const iosUiConfigurator = readIfPresent('scripts/configure-ios-ui-tests.rb');
const iosUiBuild = readIfPresent('scripts/build-ios-ui-test-products-guarded.sh');
const iosUiRun = readIfPresent('scripts/run-ios-ui-tests-guarded.sh');
const iosDirectUiRun = readIfPresent('scripts/run-ios-xcuitest-direct.py');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exactSourceBlock(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const duplicateStart = startIndex < 0 ? -1 : source.indexOf(start, startIndex + start.length);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || duplicateStart >= 0 || endIndex <= startIndex) {
    throw new Error(`iOS UI test has an invalid ${label} source boundary.`);
  }
  return source.slice(startIndex, endIndex);
}

function assertSourceOrder(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const index = source.indexOf(token, cursor + 1);
    if (index < 0) throw new Error(`iOS UI test ${label} is missing ordered token: ${token}`);
    cursor = index;
  }
}

function verifyXcodeDiagnosticsDisabled(source, label) {
  const exactPolicy = '-collect-test-diagnostics never';
  if (source.split(exactPolicy).length !== 2) {
    throw new Error(`${label} must set the exact no-diagnostics policy once.`);
  }
  const xcodeStart = source.indexOf('xcodebuild');
  const policyStart = source.indexOf(exactPolicy, xcodeStart);
  const testStart = source.indexOf('test-without-building', policyStart);
  if (xcodeStart < 0 || policyStart <= xcodeStart || testStart <= policyStart) {
    throw new Error(`${label} must bind the no-diagnostics policy to its xcodebuild test invocation.`);
  }
}

function verifyXcodeDiagnosticsAdversaries(source, label) {
  for (const [mutation, replacement] of [
    ['missing policy', ''],
    ['on-failure policy', '-collect-test-diagnostics on-failure'],
    ['duplicated policy', '-collect-test-diagnostics never \\\n+  -collect-test-diagnostics never'],
  ]) {
    const mutated = source.replace('-collect-test-diagnostics never', replacement);
    let rejected = false;
    try {
      verifyXcodeDiagnosticsDisabled(mutated, label);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${label} accepted diagnostics adversary: ${mutation}`);
  }
}

const IOS_RECORDING_LIFECYCLE_BLOCKS = [
  ['short recording test', '  func testShortRecordingLifecycle() throws {', '  func testRapidPauseResumeFirstTap() throws {', '4a588b98d7eeb9b7d54a3ffead26d8638a00675c170ed6d6c734e7b847bddf16'],
  ['stop helper', '  private func stopCurrentRecording() {', '  private func authorizeMicrophoneIfPresented() {', '8e94a10d137cc14d85d192f34c13adca749b55efaca9ce339424685c06bf168f'],
  ['permission helper', '  private func authorizeMicrophoneIfPresented() {', '  private func waitForSettledPostRecordingState(timeout: TimeInterval) -> Bool {', 'cc866500cecf01c53833bba269516ee6779b39d7fc7c10971348727aa1d560dd'],
  ['settled-state helper', '  private func waitForSettledPostRecordingState(timeout: TimeInterval) -> Bool {', '  private func assertSingleBackReturnsHomeIfNeeded() {', '420f0b83f4d468f4b352d73418d32e287b29841557d945af5566e7f61d51d761'],
  ['Back-to-Home helper', '  private func assertSingleBackReturnsHomeIfNeeded() {', '  private func tapTab(named name: String, fallbackX: CGFloat) {', '9c0cd4483c927885a9f0d878f1607527f48a276fefa5dd6395e0b999028a5662'],
];

function verifyIosRecordingLifecycle(source) {
  const blocks = Object.fromEntries(IOS_RECORDING_LIFECYCLE_BLOCKS.map(([label, start, end, expectedHash]) => {
    const body = exactSourceBlock(source, start, end, label);
    if (sha256(body) !== expectedHash) throw new Error(`iOS UI test ${label} does not match the reviewed safety contract.`);
    return [label, body];
  }));
  assertSourceOrder(blocks['short recording test'], [
    'app.buttons["Stop and save"].tap()',
    'waitForSettledPostRecordingState(timeout: 20)',
    'attach("recording-saved")',
    'assertSingleBackReturnsHomeIfNeeded()',
  ], 'short recording test');
  assertSourceOrder(blocks['stop helper'], [
    'stop.tap()',
    'waitForSettledPostRecordingState(timeout: 30)',
  ], 'stop helper');
  assertSourceOrder(blocks['settled-state helper'], [
    'let recordingSurfaceIsGone = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists',
    'let homeIsSettled = home.exists && record.exists && record.isHittable',
    'let detailIsSettled = detailBack.exists && detailBack.isHittable',
    'detailTranscript.exists && detailTranscript.isHittable',
    'if recordingSurfaceIsGone && (homeIsSettled || detailIsSettled)',
    'consecutiveSettledSamples += 1',
    'if consecutiveSettledSamples == 2 { return true }',
  ], 'settled-state helper');
  assertSourceOrder(blocks['Back-to-Home helper'], [
    'let back = app.buttons["Back"].firstMatch',
    'back.exists && back.isHittable',
    'back.tap()',
    'app.staticTexts["RECENT"].waitForExistence(timeout: 10)',
    'app.buttons["Record a meeting"].waitForExistence(timeout: 5)',
  ], 'Back-to-Home helper');
}

function verifyIosRecordingLifecycleAdversaries(source) {
  const mutations = [
    ['stale helper name', 'waitForSettledPostRecordingState', 'waitForDurablePostRecordingState'],
    ['outgoing control omission', '!stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists', '!stop.exists && !pause.exists && !recording.exists && !paused.exists'],
    ['weakened conjunction', 'if recordingSurfaceIsGone && (homeIsSettled || detailIsSettled)', 'if recordingSurfaceIsGone || (homeIsSettled || detailIsSettled)'],
    ['removed destination hittability', 'detailTranscript.exists && detailTranscript.isHittable', 'detailTranscript.exists'],
    ['single unstable sample', 'if consecutiveSettledSamples == 2 { return true }', 'if consecutiveSettledSamples == 1 { return true }'],
    ['omitted short-test call', 'waitForSettledPostRecordingState(timeout: 20)', 'true'],
    ['omitted stop-helper call', 'waitForSettledPostRecordingState(timeout: 30)', 'true'],
    ['attach before assertion', '    attach("recording-saved")\n    assertSingleBackReturnsHomeIfNeeded()', '    assertSingleBackReturnsHomeIfNeeded()\n    attach("recording-saved")'],
    ['comment-only token', 'let recordingSurfaceIsGone = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists', 'let recordingSurfaceIsGone = true // !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists'],
    ['dead-code token', 'let recordingSurfaceIsGone = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists', 'let recordingSurfaceIsGone = true; if false { _ = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists }'],
  ];
  for (const [label, before, after] of mutations) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`iOS UI verifier adversary is stale: ${label}`);
    const mutated = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
    let rejected = false;
    try {
      verifyIosRecordingLifecycle(mutated);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`iOS UI verifier accepted adversary: ${label}`);
  }
}

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
  verifyXcodeDiagnosticsDisabled(stop, 'iOS attach-only stop harness');
  verifyXcodeDiagnosticsAdversaries(stop, 'iOS attach-only stop harness');
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
  ]) {
    if (!ui.includes(token)) throw new Error(`iOS UI test is missing a bounded recording-lifecycle oracle: ${token}`);
  }
  verifyIosRecordingLifecycle(ui);
  verifyIosRecordingLifecycleAdversaries(ui);
  if (generatedUi != null && generatedUi !== ui) {
    throw new Error('Generated iOS UI test diverges from its reviewed source template.');
  }
  if (ui.includes("label CONTAINS[c] 'Recent' OR label CONTAINS[c] 'recording'")) {
    throw new Error('iOS UI test still uses the stale post-recording substring oracle.');
  }
  const permissionHelper = ui.slice(
    ui.indexOf('private func authorizeMicrophoneIfPresented()'),
    ui.indexOf('private func waitForSettledPostRecordingState'),
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
  verifyXcodeDiagnosticsDisabled(iosUiRun, 'iOS UI-test runner');
  verifyXcodeDiagnosticsAdversaries(iosUiRun, 'iOS UI-test runner');
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
