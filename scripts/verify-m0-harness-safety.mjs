#!/usr/bin/env node

import assert from 'node:assert/strict';
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

const IOS_DIRECT_SHARD_TIMEOUTS = new Map([
  ['navigation-audit', '60.0'],
  ['short-recording-lifecycle', '90.0'],
  ['rapid-pause-resume', '60.0'],
  ['paused-state', '60.0'],
  ['background-recording', '90.0'],
  ['discard-recording', '60.0'],
  ['process-death-recovery', '150.0'],
  ['long-recording', '180.0'],
]);

function verifyDirectIosSharding(source) {
  for (const [testName, timeout] of IOS_DIRECT_SHARD_TIMEOUTS) {
    const token = `    "${testName}": ${timeout},`;
    if (source.split(token).length !== 2) {
      throw new Error(`Direct iOS UI-test runner has invalid ${testName} timeout policy.`);
    }
  }
  for (const token of [
    'if len(set(requested)) != len(requested):',
    'if set(CASE_TIMEOUT_SECONDS) != set(ALLOWED_TESTS):',
    'for case_name, method, timeout_seconds in selected_cases:',
    'listener = SanitizedListener(result_path.parent, case_name)',
    'case_config = TestConfig(',
    'case_config.tests_to_run = [method]',
    'timeout=timeout_seconds',
    'case_results[case_name] = sanitized_case_result(',
    'if execution_error is not None:',
    'break',
    '"completedCaseCount": len(case_results)',
    '"activeCase": active_case',
    '"CASE_TIMEOUT"',
    '"DTX_DISCONNECTED"',
    '"UNEXPECTED_TEST_EVENT"',
  ]) {
    if (!source.includes(token)) throw new Error(`Direct iOS UI-test sharding is missing bounded token: ${token}`);
  }
  assertSourceOrder(source, [
    'selected_cases = case_plan(requested)',
    'for case_name, method, timeout_seconds in selected_cases:',
    'listener = SanitizedListener(result_path.parent, case_name)',
    'case_config = TestConfig(',
    'case_config.tests_to_run = [method]',
    'await XCUITestService(rsd).run(',
    'case_results[case_name] = sanitized_case_result(',
    'if execution_error is not None:',
    'break',
  ], 'direct sharded runner');
  for (const forbidden of [
    'config.tests_to_run = selected',
    'asyncio.gather(',
    'asyncio.create_task(',
    'asyncio.ensure_future(',
  ]) {
    if (source.includes(forbidden)) throw new Error(`Direct iOS UI-test runner exposes unsafe sharding token: ${forbidden}`);
  }
}

function verifyDirectIosShardingAdversaries(source) {
  for (const [label, before, after] of [
    ['multi-method shard', 'case_config.tests_to_run = [method]', 'case_config.tests_to_run = [method, method]'],
    ['unbounded shard', 'timeout=timeout_seconds', 'timeout=None'],
    ['parallel shards', 'for case_name, method, timeout_seconds in selected_cases:', 'await asyncio.gather('],
    ['missing ambiguity break', '            if execution_error is not None:\n                break', '            if execution_error is not None:\n                pass'],
    ['duplicate timeout key', '    "navigation-audit": 60.0,', '    "navigation-audit": 60.0,\n    "navigation-audit": 60.0,'],
  ]) {
    assert.throws(
      () => verifyDirectIosSharding(source.replace(before, after)),
      /Direct iOS UI-test|missing ordered token/,
      `Direct iOS UI-test verifier accepted ${label}.`,
    );
  }
}

const IOS_RECORDING_LIFECYCLE_BLOCKS = [
  ['keep interrupted test', '  func testKeepInterruptedRecording() throws {', '  func testNavigationAudit() throws {', '90619bdb3210b911c455f2d2478d848fdf054ee69030caa1cdc00fa048e5212f'],
  ['short recording test', '  func testShortRecordingLifecycle() throws {', '  func testRapidPauseResumeFirstTap() throws {', '9edda727c030605726a7dc078f0d6f02a54da95f879436d2c3ba737fe741a99e'],
  ['process-death recovery test', '  func testProcessDeathRecovery() throws {', '  func testLongRecordingWithBackgroundAndPauses() throws {', '2eae4854c868ef298817f300adcdf4f63203fbbb585babf318dd1fa7db353f9c'],
  ['stop helper', '  private func stopCurrentRecording() {', '  private func authorizeMicrophoneIfPresented() {', 'd091ddc73b9067eb4e58b2d3940eeee3aa4c6e35185c38d8e3023c334a69f8e6'],
  ['permission helper', '  private func authorizeMicrophoneIfPresented() {', '  private func waitForRecorderFinalizationSurface(timeout: TimeInterval) -> Bool {', 'cc866500cecf01c53833bba269516ee6779b39d7fc7c10971348727aa1d560dd'],
  ['finalization-surface helper', '  private func waitForRecorderFinalizationSurface(timeout: TimeInterval) -> Bool {', '  private func requireHomeRecordingCount(timeout: TimeInterval) -> Int {', 'cb62cc6978fdd618a0fd9cf43e7b3d8bf934756dce61c07051d7bdbf0f7fc175'],
  ['recovery evidence helpers', '  private func requireHomeRecordingCount(timeout: TimeInterval) -> Int {', '  private func assertSingleBackReturnsHomeIfNeeded() {', '3228cbde035be6fb8bc8423be9996cb11293f972de42d71f7c38c421e5f39106'],
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
    'waitForRecorderFinalizationSurface(timeout: 20)',
    'attach("recording-saved")',
    'assertSingleBackReturnsHomeIfNeeded()',
  ], 'short recording test');
  assertSourceOrder(blocks['stop helper'], [
    'stop.tap()',
    'waitForRecorderFinalizationSurface(timeout: 30)',
  ], 'stop helper');
  assertSourceOrder(blocks['keep interrupted test'], [
    'keep.tap()',
    'XCTAssertFalse(keep.waitForExistence(timeout: 10)',
    'assertCurrentMeetingHasDurableAudio(timeout: 20)',
  ], 'keep interrupted test');
  assertSourceOrder(blocks['process-death recovery test'], [
    'let previousMeetingCount = requireHomeRecordingCount(timeout: 8)',
    'startFreshRecording()',
    'app.terminate()',
    'app.launch()',
    'waitForHomeRecordingCount(previousMeetingCount + 1, timeout: 25)',
    'app.buttons.matching(identifier: "meeting-card").firstMatch',
    'newestMeeting.tap()',
    'assertCurrentMeetingHasDurableAudio(timeout: 20)',
    'let recoveredDuration = requireCurrentMeetingDurationSeconds()',
    'XCTAssertTrue((1...60).contains(recoveredDuration)',
    'XCTAssertFalse(app.buttons["Stop and save"].exists',
  ], 'process-death recovery test');
  assertSourceOrder(blocks['finalization-surface helper'], [
    'let recordingSurfaceIsGone = !stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists',
    'let homeIsSettled = home.exists && record.exists && record.isHittable',
    'let detailIsSettled = detailBack.exists && detailBack.isHittable',
    'detailTranscript.exists && detailTranscript.isHittable',
    'if recordingSurfaceIsGone && (homeIsSettled || detailIsSettled)',
    'consecutiveSettledSamples += 1',
    'if consecutiveSettledSamples == 2 { return true }',
  ], 'finalization-surface helper');
  assertSourceOrder(blocks['recovery evidence helpers'], [
    'if let count = currentHomeRecordingCount() { return count }',
    'if currentHomeRecordingCount() == expected { return true }',
    'matches.count == 1',
    '"^Saved audio segments: [1-9][0-9]*$"',
    'audioAvailable.exists || positiveSegments.count == 1 || reTranscribe.exists || audioKept.count > 0',
    'rawParts.count == parts.count',
    'XCTFail("Meeting detail did not expose a bounded public duration.")',
  ], 'recovery evidence helpers');
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
    ['overstated helper name', 'waitForRecorderFinalizationSurface', 'waitForDurablePostRecordingState'],
    ['outgoing control omission', '!stop.exists && !pause.exists && !resume.exists && !recording.exists && !paused.exists', '!stop.exists && !pause.exists && !recording.exists && !paused.exists'],
    ['weakened conjunction', 'if recordingSurfaceIsGone && (homeIsSettled || detailIsSettled)', 'if recordingSurfaceIsGone || (homeIsSettled || detailIsSettled)'],
    ['removed destination hittability', 'detailTranscript.exists && detailTranscript.isHittable', 'detailTranscript.exists'],
    ['single unstable sample', 'if consecutiveSettledSamples == 2 { return true }', 'if consecutiveSettledSamples == 1 { return true }'],
    ['omitted short-test call', 'waitForRecorderFinalizationSurface(timeout: 20)', 'true'],
    ['omitted stop-helper call', 'waitForRecorderFinalizationSurface(timeout: 30)', 'true'],
    ['unchanged meeting count', 'previousMeetingCount + 1', 'previousMeetingCount'],
    ['generic recovery card', 'app.buttons.matching(identifier: "meeting-card").firstMatch', 'app.buttons.firstMatch'],
    ['omitted durable audio proof', 'assertCurrentMeetingHasDurableAudio(timeout: 20)', 'true'],
    ['unbounded recovered duration', 'XCTAssertTrue((1...60).contains(recoveredDuration)', 'XCTAssertTrue(recoveredDuration >= 0'],
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
    ui.indexOf('private func waitForRecorderFinalizationSurface'),
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
  verifyDirectIosSharding(iosDirectUiRun);
  verifyDirectIosShardingAdversaries(iosDirectUiRun);
}

console.log('M0 harness safety verification passed.');
