#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateNativeResult } from '../coordination/scripts/verify-native-post-processing-contract.mjs';

const project = path.resolve(import.meta.dirname, '..');
const moduleRoot = path.join(project, 'modules', 'maina-recorder');
const capture = path.join(moduleRoot, 'ios', 'MainaIOSNativeAudioCapture.swift');
const module = path.join(moduleRoot, 'ios', 'MainaRecorderModule.swift');
const podspec = path.join(moduleRoot, 'ios', 'MainaRecorder.podspec');
const qwen = path.join(moduleRoot, 'ios', 'MainaQwenAsr.swift');
const modelPackLifecycle = path.join(moduleRoot, 'ios', 'MainaModelPackLifecycle.swift');
const modelPackLifecycleTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSModelPackLifecycleTests.swift');
const continuedProcessing = path.join(moduleRoot, 'ios', 'MainaIOSContinuedProcessing.swift');
const continuedProcessingPolicy = path.join(moduleRoot, 'ios', 'MainaIOSContinuedProcessingRetentionPolicy.swift');
const continuedProcessingPolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSContinuedProcessingRetentionPolicyTests.swift');
const callRecoveryPolicy = path.join(moduleRoot, 'ios', 'MainaIOSCallRecoveryPolicy.swift');
const callRecoveryPolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSCallRecoveryPolicyTests.swift');
const terminalPolicy = path.join(moduleRoot, 'ios', 'MainaIOSNativeCaptureTerminalPolicy.swift');
const terminalPolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSNativeCaptureTerminalPolicyTests.swift');
const pipelineWake = path.join(moduleRoot, 'ios', 'MainaIOSPipelineWake.swift');
const pipelineWakePolicy = path.join(moduleRoot, 'ios', 'MainaIOSPipelineWakePolicy.swift');
const pipelineWakePolicyTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSPipelineWakePolicyTests.swift');
const nativePostProcessingStore = path.join(moduleRoot, 'ios', 'MainaNativePostProcessingStore.swift');
const nativePostProcessingCoordinator = path.join(moduleRoot, 'ios', 'MainaNativePostProcessingCoordinator.swift');
const nativePostProcessingTests = path.join(project, 'scripts', 'fixtures', 'MainaIOSNativePostProcessingTests.swift');
const continuedProcessingPlugin = path.join(project, 'plugins', 'withMainaIOSContinuedProcessing.js');
const sherpaHeaders = path.join(moduleRoot, 'ios', 'vendor', 'sherpa-onnx.xcframework', 'ios-arm64', 'Headers');
const config = JSON.parse(readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
const appConfig = JSON.parse(readFileSync(path.join(project, 'app.json'), 'utf8'));
const captureSource = readFileSync(capture, 'utf8');
const callRecoveryPolicySource = readFileSync(callRecoveryPolicy, 'utf8');
const terminalPolicySource = readFileSync(terminalPolicy, 'utf8');
const nativePostProcessingStoreSource = readFileSync(nativePostProcessingStore, 'utf8');
const nativePostProcessingCoordinatorSource = readFileSync(nativePostProcessingCoordinator, 'utf8');

function verifyTerminalStopOrdering(source) {
  const anchor = 'terminalStopGeneration = stoppedGeneration';
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex < 0 || source.indexOf(anchor, anchorIndex + anchor.length) >= 0) {
    throw new Error('iOS explicit stop must contain exactly one successful terminal-generation anchor.');
  }
  const overflowSource = source.slice(0, anchorIndex);
  for (const token of ['state = .finalizing', 'resetIdle()', 'return ["requested": true]']) {
    if (!overflowSource.includes(token)) {
      throw new Error(`iOS terminal-generation overflow branch is incomplete: ${token}`);
    }
  }
  let cursor = anchorIndex + anchor.length;
  for (const token of [
    'state = .finalizing',
    'pendingTerminalStop = PendingTerminalStop(',
    'closeActiveChunk(reason: "stop", preserve: true)',
    'queue.asyncAfter(',
  ]) {
    const tokenIndex = source.indexOf(token, cursor);
    if (tokenIndex < 0) {
      throw new Error(`iOS issued-generation terminal ordering is incomplete: ${token}`);
    }
    cursor = tokenIndex + token.length;
  }
}

const terminalOrderingFixture = `
state = .finalizing
resetIdle()
return ["requested": true]
terminalStopGeneration = stoppedGeneration
state = .finalizing
pendingTerminalStop = PendingTerminalStop(
closeActiveChunk(reason: "stop", preserve: true)
queue.asyncAfter(
`;
verifyTerminalStopOrdering(terminalOrderingFixture);
for (const [label, fixture] of [
  ['missing normal finalizing', terminalOrderingFixture.replace(
    'terminalStopGeneration = stoppedGeneration\nstate = .finalizing',
    'terminalStopGeneration = stoppedGeneration',
  )],
  ['reordered pending owner', terminalOrderingFixture.replace(
    'state = .finalizing\npendingTerminalStop = PendingTerminalStop(',
    'pendingTerminalStop = PendingTerminalStop(\nstate = .finalizing',
  )],
  ['duplicate anchor', `${terminalOrderingFixture}\nterminalStopGeneration = stoppedGeneration`],
  ['missing overflow exit', terminalOrderingFixture.replace('resetIdle()\n', '')],
]) {
  let rejected = false;
  try {
    verifyTerminalStopOrdering(fixture);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`iOS terminal ordering self-test failed: ${label}`);
}

for (const file of [capture, module, podspec, qwen, modelPackLifecycle, modelPackLifecycleTests, continuedProcessing, continuedProcessingPolicy, continuedProcessingPolicyTests, callRecoveryPolicy, callRecoveryPolicyTests, terminalPolicy, terminalPolicyTests, pipelineWake, pipelineWakePolicy, pipelineWakePolicyTests, nativePostProcessingStore, nativePostProcessingCoordinator, nativePostProcessingTests, continuedProcessingPlugin]) {
  if (!existsSync(file) || readFileSync(file, 'utf8').trim().length === 0) {
    throw new Error(`Required iOS recorder source is missing: ${file}`);
  }
}
const modelPackLifecycleSource = readFileSync(modelPackLifecycle, 'utf8');
for (const token of [
  'maina.model-pack-manifest.v1',
  'canonicalJSON(unsigned)',
  'same_manifest_and_verified_prefix',
  'same_manifest_invalid_bytes_removed',
  'SMOKE_RECEIPT_MISMATCH',
  'MODEL_PACK_WRITER_CONFLICT',
  'MODEL_PACK_READER_PIN_FAILED',
  'rollbackAfterOpenFailure',
  'noteExactResult',
  'maina.model-pack-result-record.v2',
  'resultPayloadSha256ById',
  'unverifiedLegacyResultIds',
  'validResultRecordLocation',
  'lifecycleRecordSha256',
  'packRetained',
  'currentAcquisitionURL',
  'readLifecycleManifest',
  'DOWNLOAD_WRITE_FAILED',
  'Self.engineID',
  'moveItem(at: stagingDirectory',
  'volumeAvailableCapacityForImportantUsageKey',
  'd8baaa925248e8e8ad23870208cdaf3d093623e6733aede2c23862f30c5aac62',
]) {
  if (!modelPackLifecycleSource.includes(token)) {
    throw new Error(`iOS model-pack lifecycle invariant missing: ${token}`);
  }
}
const qwenSource = readFileSync(qwen, 'utf8');
for (const token of [
  'MainaModelPackLifecycle.shared',
  'modelPacks.acquireReady()',
  'rollbackAfterOpenFailure',
  'activePack?.release()',
  'func smoke(root: URL, uri: String)',
  'precomposedStringWithCanonicalMapping',
  'func modelIdentity()',
  'func bindExactResult(',
]) {
  if (!qwenSource.includes(token)) {
    throw new Error(`iOS Qwen model-pack integration invariant missing: ${token}`);
  }
}
const moduleSource = readFileSync(module, 'utf8');
for (const token of [
  'getNativeModelPackLifecycleStatus',
  'beginNativeModelPackAcquisition',
  'stageNativeModelPackChunk',
  'verifyAndPromoteNativeModelPack',
  'native_model_result_binding_failed',
]) {
  if (!moduleSource.includes(token)) {
    throw new Error(`iOS model-pack bridge invariant missing: ${token}`);
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
  'capture-interruption-bridge-coalesced',
  'beginInterruptionBridgeIfNeeded(reason: "system-interruption")',
  'beginInterruptionBridgeIfNeeded(reason: "call-observer")',
  'interruptionBridgeStartCount',
  'interruptionBridgeExpirationCount',
  'capture-recovery-signal-coalesced',
  'applicationActiveSnapshot() || recoveryBackgroundTaskIsActive()',
  'expireRecoveryBackgroundTaskSynchronously',
  'route-change-observed',
  'recorder?.isRecording != true',
  'CXCallObserver',
  'capture-recovery-vetoed-by-call',
  'MainaIOSCallRecoveryPolicy.action',
  'MainaIOSCallRecoveryPolicy.failureDisposition',
  'MainaIOSCallRecoveryPolicy.manualResumeAction',
  'recoveryAwaitingPublicSignal',
  'manual-system-recovery-requested',
  'awaitingPublicSignal',
  'recoverySignalCount',
  'recoveryRetryBudgetMs: Double = 30_000',
  'recoveryLoopStartedUptime',
  'MainaIOSCallRecoveryPolicy.refreshedCommunicationActive',
  'refreshCommunicationActiveFromObserver()',
  'chunk-allocated',
  'next.record(), next.isRecording',
  'private var terminalMeetingId: String?',
  'private var pendingTerminalStop: PendingTerminalStop?',
  'private var terminalStopGeneration = 0',
  'MainaIOSNativeCaptureTerminalPolicy.nextTerminalGeneration(',
  'terminalReceiptSchemaVersion = "maina.ios-native-stop.v1"',
  'state = .finalizing',
  'queue.asyncAfter(deadline: .now() + .milliseconds(Self.terminalStopTimeoutMs))',
  'func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool)',
  'func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?)',
  'MainaIOSNativeCaptureTerminalPolicy.completionAction(',
  'let evidence = terminalAudioEvidence(in: directory)',
  'readable.fileFormat.sampleRate > 0',
  'MainaIOSNativeCaptureTerminalPolicy.isCleanStop(',
  'terminalPublicationState = clean ? "succeeded" : "recovery_required"',
  'terminalReasonCode = clean ? "stop_succeeded" : "stop_timeout_or_error"',
]) {
  if (!captureSource.includes(token)) {
    throw new Error(`iOS recorder reliability invariant missing: ${token}`);
  }
}
const terminalStopStart = captureSource.indexOf('func stop() -> [String: Any]');
const terminalStopEnd = captureSource.indexOf('func abort() -> [String: Any]', terminalStopStart);
const terminalStopSource = captureSource.slice(terminalStopStart, terminalStopEnd);
if (terminalStopStart < 0 || terminalStopEnd < 0) throw new Error('iOS explicit stop source is missing.');
verifyTerminalStopOrdering(terminalStopSource);
const terminalCompletionStart = captureSource.indexOf('private func completePendingTerminalStop(');
const terminalCompletionEnd = captureSource.indexOf('@discardableResult\n  private func prepareSystemPause', terminalCompletionStart);
const terminalCompletionSource = captureSource.slice(terminalCompletionStart, terminalCompletionEnd);
const terminalActionIndex = terminalCompletionSource.indexOf('MainaIOSNativeCaptureTerminalPolicy.completionAction(');
const terminalGuardIndex = terminalCompletionSource.indexOf('guard let pending, action != .ignore');
const terminalPublishIndex = terminalCompletionSource.indexOf('publishTerminalStopReceipt(');
const terminalClearIndex = terminalCompletionSource.indexOf('pendingTerminalStop = nil');
const terminalIdleIndex = terminalCompletionSource.indexOf('resetIdle()');
if (terminalCompletionStart < 0 || terminalCompletionEnd < 0
  || terminalActionIndex < 0
  || terminalGuardIndex <= terminalActionIndex
  || terminalPublishIndex <= terminalGuardIndex
  || terminalClearIndex <= terminalPublishIndex
  || terminalIdleIndex <= terminalClearIndex
) {
  throw new Error('iOS terminal callback must validate its fence, publish one receipt, clear the lease, then enter idle.');
}
if (terminalCompletionSource.includes('recoveryGeneration')) {
  throw new Error('iOS terminal completion must never depend on the mutable call-recovery generation.');
}
for (const token of [
  'case validateAudio = "validate_audio"',
  'case recoveryRequired = "recovery_required"',
  'current < Int.max',
  'pendingGeneration: Int?',
  'completionGeneration: Int',
  'recorderIdentityMatches',
  'completionGeneration == pendingGeneration',
  'stateIsFinalizing',
  'case "recorder_succeeded"',
  'case "recorder_failed", "encode_error", "timeout"',
  'meetingId?.isEmpty == false',
  'generation > 0',
  '!finalizationErrorPresent',
  'segmentCount > 0',
  'payloadBytes > 0',
  'terminalEvidenceComplete',
  'stoppedState == "recording" && closeOutcome == "finalized"',
  'stoppedState == "paused" && closeOutcome == "no_active"',
]) {
  if (!terminalPolicySource.includes(token)) {
    throw new Error(`iOS terminal-receipt policy invariant missing: ${token}`);
  }
}
for (const token of [
  'private var inferenceInFlight = false',
  'func setRecordingActive',
  'func releaseAsr',
  'MainaNativePostProcessingBridgeCodec',
  'MainaNativePostProcessingAudioPlanner',
  'audioStartMs',
  'audioEndMs',
  'audio_fingerprint_mismatch',
  'MainaNativePostProcessingQwenAdapter',
  'MainaNativePostProcessingTranscriptStitcher',
  'store.claimFirstIncomplete',
  'store.commitWindow',
  'store.failWindow',
  'onChanged(event)',
  'Invalid or stale callbacks cannot gain a second mutation path.',
]) {
  if (!nativePostProcessingCoordinatorSource.includes(token)) {
    throw new Error(`iOS native post-processing coordinator invariant missing: ${token}`);
  }
}
for (const token of [
  'cannotInterruptOthersDomain = NSOSStatusErrorDomain',
  'cannotInterruptOthersCode = 560_557_684',
  'domain == cannotInterruptOthersDomain && code == cannotInterruptOthersCode',
  'static func recoveryMayRetry',
  'static func recoveryLoopStart',
  'static func interruptionBridgeAction',
  'static func shouldRetainAfterInterruptionBridgeExpiration',
  'static func backgroundExpirationMayApply',
  'case queueSystemRecovery',
  'case resumeDeliberatePause',
  'case rejectCommunicationActive',
]) {
  if (!callRecoveryPolicySource.includes(token)) {
    throw new Error(`iOS call-recovery policy invariant missing: ${token}`);
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
  'applicationIsActiveOnMainThread()',
  'let applicationIsActive = Self.applicationIsActiveOnMainThread()',
  'DispatchQueue.main.sync',
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
const continuedApplicationStateReads = readFileSync(continuedProcessing, 'utf8')
  .match(/UIApplication\.shared\.applicationState/g) ?? [];
if (continuedApplicationStateReads.length !== 2) {
  throw new Error('iOS continued processing must isolate UIApplication state reads to one main-thread helper.');
}
const fallbackTaskStart = readFileSync(continuedProcessing, 'utf8').indexOf('private func beginFallbackTask');
const fallbackTaskEnd = readFileSync(continuedProcessing, 'utf8').lastIndexOf('\n}');
const fallbackTaskSource = readFileSync(continuedProcessing, 'utf8').slice(fallbackTaskStart, fallbackTaskEnd);
for (const token of [
  'reserveFallbackTask(identifier: identifier, leaseId: leaseId)',
  'activateFallbackTask(identifier: identifier, leaseId: leaseId, task: task)',
  'takeFallbackTask(identifier: identifier, expectedLeaseId: leaseId)',
  'UIApplication.shared.endBackgroundTask(expired.task)',
  'queue.async',
  'latestFallbackLeaseMatches(identifier: identifier, leaseId: leaseId)',
]) {
  if (!fallbackTaskSource.includes(token)) {
    throw new Error(`iOS fallback background-task lease invariant missing: ${token}`);
  }
}
if (fallbackTaskSource.includes('DispatchQueue.main.sync') ||
    fallbackTaskSource.includes('queue.sync')) {
  throw new Error('iOS fallback background-task handling must not synchronously invert main and registry queues.');
}
const fallbackExpiryStart = fallbackTaskSource.indexOf('private func expireFallbackTaskSynchronously');
const fallbackExpiryEnd = fallbackTaskSource.indexOf('private func endFallbackTask', fallbackExpiryStart);
const fallbackExpirySource = fallbackTaskSource.slice(fallbackExpiryStart, fallbackExpiryEnd);
if (fallbackExpirySource.indexOf('UIApplication.shared.endBackgroundTask(expired.task)') < 0 ||
    fallbackExpirySource.indexOf('UIApplication.shared.endBackgroundTask(expired.task)') >=
      fallbackExpirySource.indexOf('queue.async')) {
  throw new Error('iOS fallback expiration must end its exact UIKit task before asynchronous registry work.');
}
for (const methodName of ['func begin(', 'func isActive(']) {
  const methodStart = readFileSync(continuedProcessing, 'utf8').indexOf(methodName);
  const queueStart = readFileSync(continuedProcessing, 'utf8').indexOf('queue.sync', methodStart);
  const stateRead = readFileSync(continuedProcessing, 'utf8').indexOf(
    'let applicationIsActive = Self.applicationIsActiveOnMainThread()',
    methodStart
  );
  if (methodStart < 0 || queueStart < 0 || stateRead < methodStart || stateRead > queueStart) {
    throw new Error(`iOS ${methodName} must read UIKit state on main before entering the registry queue.`);
  }
}
if (captureSource.includes('UIApplication.shared.applicationState') ||
    captureSource.includes('UIApplication.shared.backgroundTimeRemaining')) {
  throw new Error('iOS capture recovery must not read UIApplication lifecycle state from its worker queue.');
}
const recoveryWatcherStart = captureSource.indexOf('private func canContinueRecoveryWatcher');
const recoveryWatcherEnd = captureSource.indexOf('private func beginRecoveryBackgroundTaskIfNeeded', recoveryWatcherStart);
const recoveryWatcherSource = captureSource.slice(recoveryWatcherStart, recoveryWatcherEnd);
for (const token of [
  'refreshCommunicationActiveFromObserver()',
  'applicationActiveSnapshot() || recoveryBackgroundTaskIsActive()',
]) {
  if (!recoveryWatcherSource.includes(token)) {
    throw new Error(`iOS recovery watcher finite-lease invariant missing: ${token}`);
  }
}
for (const token of [
  'UIApplication.willResignActiveNotification',
  'setApplicationActive(false)',
  'recoveryAttemptIsAuthorized(generation: generation, interruptionCycle: cycle)',
  'recoveryBackgroundTaskMatches(generation: generation, interruptionCycle: interruptionCycle)',
]) {
  if (!captureSource.includes(token)) {
    throw new Error(`iOS recovery attempt lease/foreground invariant missing: ${token}`);
  }
}
for (const token of [
  'PRAGMA journal_mode=WAL',
  'PRAGMA synchronous=FULL',
  'BEGIN IMMEDIATE',
  'CREATE TABLE IF NOT EXISTS runtime_owner',
  'precedingTranscriptText',
  'func claimFirstIncomplete',
  'func setRecordingActive',
  'func acknowledge',
  'func releaseRuntime',
  'result_payload_sha256',
  'model_manifest_sha256',
  'model_activation_generation',
  'func readResultModelBinding(',
  'ALTER TABLE runs ADD COLUMN model_manifest_sha256 TEXT',
  'ALTER TABLE runs ADD COLUMN model_activation_generation INTEGER',
  'unresolvedIntervals',
  'Owner-first lookup keeps cross-owner access indistinguishable from absence.',
]) {
  if (!nativePostProcessingStoreSource.includes(token)) {
    throw new Error(`iOS native post-processing durability invariant missing: ${token}`);
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
  'prepareIOSNativePostProcessingAudio',
  'startIOSNativePostProcessing',
  'readIOSNativePostProcessingResult',
  'acknowledgeIOSNativePostProcessingResult',
  'releaseIOSNativePostProcessingAsr',
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

const recoverySourceSections = [
  ['route recovery', 'private func handleRouteChange', 'private func handleInterruption'],
  ['interruption end', 'private func handleInterruption', 'private func handleMediaServicesReset'],
  ['foreground recovery', 'private func recoverWhenAppBecomesActive', '/**\n   * AVAudioSession can remain unavailable'],
];
for (const [label, startToken, endToken] of recoverySourceSections) {
  const start = captureSource.indexOf(startToken);
  const end = captureSource.indexOf(endToken, start + startToken.length);
  if (start < 0 || end <= start || !captureSource.slice(start, end).includes('refreshCommunicationActiveFromObserver()')) {
    throw new Error(`iOS ${label} must refresh exact CallKit state before deciding whether recovery is blocked.`);
  }
}
const scheduledRecoveryStart = captureSource.indexOf('private func scheduleRecovery');
const scheduledRecoveryEnd = captureSource.indexOf('private func beginRecoveryBackgroundTaskIfNeeded', scheduledRecoveryStart);
const scheduledRecoverySource = captureSource.slice(scheduledRecoveryStart, scheduledRecoveryEnd);
if ((scheduledRecoverySource.match(/refreshCommunicationActiveFromObserver\(\)/g) ?? []).length < 2) {
  throw new Error('iOS scheduled recovery must refresh exact CallKit state both before scheduling and before microphone reacquisition.');
}
const manualResumeStart = captureSource.indexOf('func resume() throws');
const manualResumeEnd = captureSource.indexOf('func stop()', manualResumeStart);
const manualResumeSource = captureSource.slice(manualResumeStart, manualResumeEnd);
for (const token of [
  'case .queueSystemRecovery:',
  'case .rejectCommunicationActive:',
  'case .resumeDeliberatePause:',
  'recoveryAwaitingPublicSignal = true',
  'scheduleRecovery(reason: "manual-resume-request")',
  '"waiting": state != .recording',
]) {
  if (!manualResumeSource.includes(token)) {
    throw new Error(`iOS system-pause Resume invariant missing: ${token}`);
  }
}
const backgroundExpiryStart = captureSource.indexOf('private func expireRecoveryBackgroundTaskSynchronously');
const backgroundExpiryEnd = captureSource.indexOf('private func endRecoveryBackgroundTask', backgroundExpiryStart);
const backgroundExpirySource = captureSource.slice(backgroundExpiryStart, backgroundExpiryEnd);
for (const token of [
  'MainaIOSCallRecoveryPolicy.shouldRetainAfterInterruptionBridgeExpiration',
  'recoveryAwaitingPublicSignal = MainaIOSCallRecoveryPolicy',
  'interruptionBridgeExpirationCount += 1',
  '"interruption-bridge-expired"',
  'recoveryGeneration += 1',
  'recoveryLoopStartedUptime = nil',
]) {
  if (!backgroundExpirySource.includes(token)) {
    throw new Error(`iOS background-exhaustion pending-generation invariant missing: ${token}`);
  }
}
if (backgroundExpirySource.includes('queue.sync')) {
  throw new Error('iOS background-task expiration must never block the main thread on the capture queue.');
}
if (backgroundExpirySource.indexOf('UIApplication.shared.endBackgroundTask(expired.task)') < 0 ||
    backgroundExpirySource.indexOf('UIApplication.shared.endBackgroundTask(expired.task)') >=
      backgroundExpirySource.indexOf('queue.async')) {
  throw new Error('iOS background-task expiration must return the UIKit assertion before asynchronous state or journal work.');
}
const expiryBeforeAsync = backgroundExpirySource.slice(0, backgroundExpirySource.indexOf('queue.async'));
if (expiryBeforeAsync.includes('appendJournal(') || expiryBeforeAsync.includes('synchronize()')) {
  throw new Error('iOS background-task expiration must perform no journal or filesystem sync before returning the assertion.');
}
const interruptionStart = captureSource.indexOf('private func handleInterruption');
const interruptionEnd = captureSource.indexOf('private func handleMediaServicesReset', interruptionStart);
const interruptionSource = captureSource.slice(interruptionStart, interruptionEnd);
const interruptionPrepare = interruptionSource.indexOf('prepareSystemPause(reason: "system-interruption")');
const interruptionBridge = interruptionSource.indexOf('beginInterruptionBridgeIfNeeded(reason: "system-interruption")');
const interruptionComplete = interruptionSource.indexOf('completeSystemPause(reason: "system-interruption"');
if (interruptionPrepare < 0 || interruptionBridge <= interruptionPrepare || interruptionComplete <= interruptionBridge) {
  throw new Error('iOS must latch system-pause authority, acquire the finite bridge, then finalize the chunk.');
}
const callObserverStart = captureSource.indexOf('func callObserver(');
const callObserverEnd = captureSource.indexOf('private func fail(', callObserverStart);
const callObserverSource = captureSource.slice(callObserverStart, callObserverEnd);
const callPrepare = callObserverSource.indexOf('prepareSystemPause(reason: "call-observer")');
const callBridge = callObserverSource.indexOf('beginInterruptionBridgeIfNeeded(reason: "call-observer")');
const callComplete = callObserverSource.indexOf('completeSystemPause(reason: "call-observer"');
if (callPrepare < 0 || callBridge <= callPrepare || callComplete <= callBridge) {
  throw new Error('iOS CallKit activation must latch pause authority, acquire the same bridge, then finalize the chunk.');
}
const pausePrepareStart = captureSource.indexOf('private func prepareSystemPause');
const pauseCompleteStart = captureSource.indexOf('private func completeSystemPause', pausePrepareStart);
const pausePrepareSource = captureSource.slice(pausePrepareStart, pauseCompleteStart);
for (const token of ['interrupted = true', 'stopTimers()', 'state = .pausing']) {
  if (!pausePrepareSource.includes(token)) {
    throw new Error(`iOS early interruption latch is incomplete: ${token}`);
  }
}
for (const forbidden of ['closeActiveChunk(', 'appendJournal(']) {
  if (pausePrepareSource.includes(forbidden)) {
    throw new Error(`iOS early interruption latch must avoid pre-assertion file work: ${forbidden}`);
  }
}
const pauseCompleteEnd = captureSource.indexOf('private func beginSystemPause', pauseCompleteStart);
const pauseCompleteSource = captureSource.slice(pauseCompleteStart, pauseCompleteEnd);
for (const token of ['closeActiveChunk(reason: reason, preserve: true)', 'state = .paused', 'appendJournal("system-paused"']) {
  if (!pauseCompleteSource.includes(token)) {
    throw new Error(`iOS protected system-pause finalization is incomplete: ${token}`);
  }
}
const recoveryCatchStart = scheduledRecoverySource.indexOf('} catch {');
const recoveryCatchSource = scheduledRecoverySource.slice(recoveryCatchStart);
if (!recoveryCatchSource.includes('recoveryLoopStartedUptime) * 1_000')) {
  throw new Error('iOS bounded recovery must measure from the current recovery loop, not the call start.');
}
if (recoveryCatchSource.includes('recoveryStartedUptime ??')) {
  throw new Error('iOS bounded recovery must not consume its budget during the call interval.');
}
const suspensionStart = captureSource.indexOf('private func suspendRecoveryForActiveCall');
const suspensionEnd = captureSource.indexOf('@discardableResult', suspensionStart);
const suspensionSource = captureSource.slice(suspensionStart, suspensionEnd);
for (const token of ['recoveryGeneration += 1', 'recoveryLoopStartedUptime = nil']) {
  if (!suspensionSource.includes(token)) {
    throw new Error(`iOS call re-entry must revoke the current recovery loop: ${token}`);
  }
}

// This is intentionally a macOS-only static gate; Linux CI still runs TS tests.
if (process.platform === 'darwin') {
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', callRecoveryPolicy, terminalPolicy, capture,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', continuedProcessingPolicy, continuedProcessing,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', pipelineWakePolicy, pipelineWake,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', nativePostProcessingStore, nativePostProcessingCoordinator,
  ], { stdio: 'inherit' });
  const nativePostProcessingTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-native-post-processing-'));
  const nativePostProcessingTestExecutable = path.join(nativePostProcessingTestDirectory, 'native-post-processing-tests');
  const nativePostProcessingResult = path.join(nativePostProcessingTestDirectory, 'native-post-processing-result.json');
  try {
    execFileSync('xcrun', [
      'swiftc', nativePostProcessingStore, nativePostProcessingCoordinator, nativePostProcessingTests, '-lsqlite3',
      '-o', nativePostProcessingTestExecutable,
    ], { stdio: 'inherit' });
    execFileSync(nativePostProcessingTestExecutable, [], {
      env: { ...process.env, MAINA_NATIVE_POST_PROCESSING_RESULT_OUTPUT: nativePostProcessingResult },
      stdio: 'inherit',
    });
    validateNativeResult(JSON.parse(readFileSync(nativePostProcessingResult, 'utf8')), {
      root: path.join(project, 'coordination'),
    });
  } finally {
    rmSync(nativePostProcessingTestDirectory, { recursive: true, force: true });
  }
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
  const terminalPolicyTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-terminal-policy-'));
  const terminalPolicyTestExecutable = path.join(terminalPolicyTestDirectory, 'terminal-policy-tests');
  try {
    execFileSync('xcrun', ['swiftc', terminalPolicy, terminalPolicyTests, '-o', terminalPolicyTestExecutable], { stdio: 'inherit' });
    execFileSync(terminalPolicyTestExecutable, [], { stdio: 'inherit' });
  } finally {
    rmSync(terminalPolicyTestDirectory, { recursive: true, force: true });
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
  const modelPackPolicyTestDirectory = mkdtempSync(path.join(tmpdir(), 'maina-ios-model-pack-policy-'));
  const modelPackPolicyTestExecutable = path.join(modelPackPolicyTestDirectory, 'model-pack-policy-tests');
  try {
    execFileSync('xcrun', [
      'swiftc', modelPackLifecycle, modelPackLifecycleTests,
      '-o', modelPackPolicyTestExecutable,
    ], { stdio: 'inherit' });
    execFileSync(modelPackPolicyTestExecutable, [], { stdio: 'inherit' });
  } finally {
    rmSync(modelPackPolicyTestDirectory, { recursive: true, force: true });
  }
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-I', sherpaHeaders, '-typecheck', modelPackLifecycle, qwen,
  ], { stdio: 'inherit' });
}

console.log('iOS native capture source and capability boundary verified.');
