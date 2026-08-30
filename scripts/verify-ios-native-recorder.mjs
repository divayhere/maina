#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const moduleRoot = path.join(project, 'modules', 'maina-recorder');
const capture = path.join(moduleRoot, 'ios', 'MainaIOSNativeAudioCapture.swift');
const module = path.join(moduleRoot, 'ios', 'MainaRecorderModule.swift');
const podspec = path.join(moduleRoot, 'ios', 'MainaRecorder.podspec');
const qwen = path.join(moduleRoot, 'ios', 'MainaQwenAsr.swift');
const continuedProcessing = path.join(moduleRoot, 'ios', 'MainaIOSContinuedProcessing.swift');
const continuedProcessingPolicy = path.join(moduleRoot, 'ios', 'MainaIOSContinuedProcessingRetentionPolicy.swift');
const continuedProcessingPolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSContinuedProcessingRetentionPolicyTests.swift');
const callRecoveryPolicy = path.join(moduleRoot, 'ios', 'MainaIOSCallRecoveryPolicy.swift');
const callRecoveryPolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSCallRecoveryPolicyTests.swift');
const pipelineWake = path.join(moduleRoot, 'ios', 'MainaIOSPipelineWake.swift');
const pipelineWakePolicy = path.join(moduleRoot, 'ios', 'MainaIOSPipelineWakePolicy.swift');
const pipelineWakePolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSPipelineWakePolicyTests.swift');
const continuedProcessingPlugin = path.join(project, 'plugins', 'withMainaIOSContinuedProcessing.js');
const sherpaHeaders = path.join(moduleRoot, 'ios', 'vendor', 'sherpa-onnx.xcframework', 'ios-arm64', 'Headers');
const config = JSON.parse(readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
const appConfig = JSON.parse(readFileSync(path.join(project, 'app.json'), 'utf8'));
const captureSource = readFileSync(capture, 'utf8');

for (const file of [capture, module, podspec, qwen, continuedProcessing, continuedProcessingPolicy, continuedProcessingPolicyTests, callRecoveryPolicy, callRecoveryPolicyTests, pipelineWake, pipelineWakePolicy, pipelineWakePolicyTests, continuedProcessingPlugin]) {
  if (!existsSync(file) || readFileSync(file, 'utf8').trim().length === 0) {
    throw new Error(`Required iOS recorder source is missing: ${file}`);
  }
}
if (!config.apple?.modules?.includes('MainaRecorderModule')) {
  throw new Error('Expo module config does not register MainaRecorderModule for Apple.');
}
if (!appConfig.expo.ios?.infoPlist?.UIBackgroundModes?.includes('audio')) {
  throw new Error('Maina iOS must declare audio background mode for active recording.');
}
if (!appConfig.expo.ios?.infoPlist?.UIBackgroundModes?.includes('processing')) {
  throw new Error('Maina iOS must declare processing background mode for deferred transcription.');
}
if (!appConfig.expo.ios?.infoPlist?.BGTaskSchedulerPermittedIdentifiers?.includes('com.divay.maina.staging.continued-processing.*')) {
  throw new Error('Maina iOS continued-processing task identifier is not permitted.');
}
if (!appConfig.expo.ios?.infoPlist?.BGTaskSchedulerPermittedIdentifiers?.includes('com.divay.maina.staging.pipeline-network')) {
  throw new Error('Maina iOS network recovery task identifier is not permitted.');
}
if (!appConfig.expo.plugins?.includes('./plugins/withMainaIOSContinuedProcessing')) {
  throw new Error('Maina iOS must install its continued-processing AppDelegate registration plugin.');
}
if (!readFileSync(podspec, 'utf8').includes("'CallKit'")) {
  throw new Error('Maina iOS recorder must link CallKit for typed call-state veto signals.');
}
for (const token of [
  'AVAudioSession.routeChangeNotification',
  'AVAudioSession.interruptionNotification',
  'capture-journal.jsonl',
  'partial.wav',
  'chunk-finalization-conflict',
  'allowBluetoothHFP',
  'setPrefersInterruptionOnRouteDisconnect(false)',
  'AVAudioSession.mediaServicesWereResetNotification',
  'UIApplication.didBecomeActiveNotification',
  'storageReserveBytes',
  'capture-recovery-deferred',
  'beginBackgroundTask(withName: "Maina microphone recovery")',
  'capture-recovery-background-time-expired',
  'capture-recovery-signal-coalesced',
  'backgroundTimeRemaining > 4',
  'expireRecoveryBackgroundTaskSynchronously',
  'route-change-observed',
  'recorder?.isRecording != true',
  'CXCallObserver',
  'capture-recovery-vetoed-by-call',
  'MainaIOSCallRecoveryPolicy.action',
  'chunk-allocated',
  'next.record(), next.isRecording',
]) {
  if (!captureSource.includes(token)) {
    throw new Error(`iOS recorder reliability invariant missing: ${token}`);
  }
}
for (const token of [
  'com.divay.maina.staging.pipeline-network',
  'BGProcessingTaskRequest',
  'requiresNetworkConnectivity',
  'earliestBeginDate',
  'getPendingTaskRequests',
  'schedulerProtocolVersion',
  'shouldResetLegacyScheduler',
  'cancel(taskRequestWithIdentifier:',
  'previous_schedule_tuple_mismatch',
  'maxNativeScheduleAttempts = 5',
  'MainaIOSPipelineWakePolicy.shouldResetAttemptBudget',
  'persistDeferred(target',
  'claimPending()',
  'hasActiveExecution()',
  'CompletionGate',
  '.now() + .seconds(10)',
  'MainaIOSPipelineWakePolicy.scheduleAction',
  'MainaIOSPipelineWakePolicy.retainedTargetsAfterCompletion',
  'ensureRetainedTargetAfterCurrentTask()',
  'setTaskCompleted(success:',
]) {
  if (!readFileSync(pipelineWake, 'utf8').includes(token)) {
    throw new Error(`iOS pipeline-wake invariant missing: ${token}`);
  }
}
for (const token of [
  'requestIdentifierPrefix',
  'jobId: String',
  'makeUniqueIdentifier(meetingId:',
  'registerExactIdentifierIfNeeded',
  'request.strategy = .fail',
  'UIApplication.shared.applicationState == .active',
  'continued-processing-requires-foreground',
  'attach(_ task: BGTask, identifier:',
  'beginFallbackTask(identifier:',
  'expireFallbackTaskSynchronously(identifier:',
  'UIApplication.shared.endBackgroundTask(task)',
]) {
  if (!readFileSync(continuedProcessing, 'utf8').includes(token)) {
    throw new Error(`iOS continued-processing invariant missing: ${token}`);
  }
}

const recoveryDelays = captureSource
  .match(/recoveryDelaysMs\s*=\s*\[([^\]]+)\]/)?.[1]
  ?.split(',')
  .map((value) => Number(value.trim().replaceAll('_', '')));
if (!recoveryDelays?.length || recoveryDelays.some((value) => !Number.isFinite(value))) {
  throw new Error('iOS microphone recovery delays are missing or malformed.');
}
const recoveryWindowMs = recoveryDelays.reduce((sum, value) => sum + value, 0);
if (recoveryDelays[0] !== 0 || Math.max(...recoveryDelays) > 3_000 || recoveryWindowMs > 10_000) {
  throw new Error(`iOS microphone recovery must retry immediately at a capped cadence; found ${recoveryWindowMs} ms initial sequence.`);
}
for (const token of [
  'startNativeCapture',
  'requestIOSMicrophonePermission',
  'getQwenAsrStatus',
  'beginIOSContinuedProcessing',
  'schedulePipelineWake',
  'claimPendingPipelineWake',
  'pipelineWake.hasActiveExecution()',
  'bindIOSContinuedProcessingRun',
  'acknowledgeIOSContinuedProcessingDeferral',
  'onIOSPostProcessingDeferralRequested',
]) {
  if (!readFileSync(module, 'utf8').includes(token)) {
    throw new Error(`iOS module API missing: ${token}`);
  }
}
for (const token of [
  'BGContinuedProcessingTaskRequest',
  'BGTaskScheduler.shared.submit',
  'beginBackgroundTask',
  'setTaskCompleted',
  'public static func registerLaunchHandler()',
  'continued-processing-handler-unregistered',
  'claimedIdentifiers',
  'CompletionGate',
  'maina.continuedProcessing.registry.v3',
  'asrGeneration',
  'deferralRequestedAt',
  'onDeferralRequested',
  '.now() + .seconds(1)',
  'MainaIOSContinuedProcessingRetentionPolicy.prune',
]) {
  if (!readFileSync(continuedProcessing, 'utf8').includes(token)) {
    throw new Error(`iOS continued-processing invariant missing: ${token}`);
  }
}
for (const token of [
  'withAppDelegate',
  'internal import MainaRecorder',
  'MainaIOSContinuedProcessing.registerLaunchHandler()',
  'MainaIOSPipelineWake.registerLaunchHandler()',
]) {
  if (!readFileSync(continuedProcessingPlugin, 'utf8').includes(token)) {
    throw new Error(`iOS AppDelegate registration invariant missing: ${token}`);
  }
}

// This is intentionally a macOS-only static gate; Linux CI still runs TS tests.
if (process.platform === 'darwin') {
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', callRecoveryPolicy, capture,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', continuedProcessingPolicy, continuedProcessing,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', pipelineWakePolicy, pipelineWake,
  ], { stdio: 'inherit' });
  const policyTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-pipeline-policy-'));
  const policyTestExecutable = path.join(policyTestDirectory, 'pipeline-wake-policy-tests');
  try {
    execFileSync('xcrun', [
      'swiftc', pipelineWakePolicy, pipelineWakePolicyTests,
      '-o', policyTestExecutable,
    ], { stdio: 'inherit' });
    execFileSync(policyTestExecutable, [], { stdio: 'inherit' });
  } finally {
    rmSync(policyTestDirectory, { recursive: true, force: true });
  }
  const callPolicyTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-call-policy-'));
  const callPolicyTestExecutable = path.join(callPolicyTestDirectory, 'call-policy-tests');
  try {
    execFileSync('xcrun', ['swiftc', callRecoveryPolicy, callRecoveryPolicyTests, '-o', callPolicyTestExecutable], { stdio: 'inherit' });
    execFileSync(callPolicyTestExecutable, [], { stdio: 'inherit' });
  } finally {
    rmSync(callPolicyTestDirectory, { recursive: true, force: true });
  }
  const continuedPolicyTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-continued-policy-'));
  const continuedPolicyTestExecutable = path.join(continuedPolicyTestDirectory, 'continued-policy-tests');
  try {
    execFileSync('xcrun', ['swiftc', continuedProcessingPolicy, continuedProcessingPolicyTests, '-o', continuedPolicyTestExecutable], { stdio: 'inherit' });
    execFileSync(continuedPolicyTestExecutable, [], { stdio: 'inherit' });
  } finally {
    rmSync(continuedPolicyTestDirectory, { recursive: true, force: true });
  }
  if (!existsSync(sherpaHeaders)) {
    throw new Error('Verified Sherpa iOS runtime is missing; run npm run ios:runtime first.');
  }
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-I', sherpaHeaders, '-typecheck', qwen,
  ], { stdio: 'inherit' });
}

console.log('iOS native capture source and capability boundary verified.');
