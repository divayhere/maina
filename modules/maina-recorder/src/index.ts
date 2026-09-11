import { requireOptionalNativeModule } from 'expo';

export interface AudioInput {
  id: number;
  name: string;
  type: string;
}

export interface HardwareTriggerEvent {
  commandId: string;
  command: 'start' | 'toggle' | 'pause' | 'resume' | 'stop';
  source: string;
  keyCode: number;
  deviceId: number;
  deviceName: string;
  occurredAt: number;
}

export type CaptureState = 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming' | 'finalizing' | 'error';

export interface RemoteControlStatus {
  armed: boolean;
  captureState: CaptureState;
  accessibilityEnabled: boolean;
  accessibilityConnected: boolean;
  accessibilityLastLifecycle: string;
  accessibilityLastLifecycleAt: number;
  accessibilityLastLifecycleBootCount: number;
  accessibilityCurrentBootCount: number;
  accessibilityLastLifecyclePackageUpdatedAt: number;
  accessibilityCurrentPackageUpdatedAt: number;
  notificationsEnabled: boolean;
  inputDevices: string[];
  lastCommand: string;
  lastCommandId: string;
  lastSource: string;
  lastDeviceName: string;
  lastKeyCode: number;
  lastCommandAt: number;
  lastAckAction: string;
  lastAckAccepted: boolean;
  lastAckAt: number;
  trustedRemoteName: string;
}

export interface AudioRouteChangedEvent {
  change: 'added' | 'removed' | 'active-route' | string;
  deviceId: number;
  deviceType: number;
  deviceName: string;
  occurredAt: number;
}

export type NativeCaptureSourceMode = 'unprocessed' | 'voice_recognition' | 'camcorder' | 'mic';

export interface NativeCaptureStatus {
  state: CaptureState;
  meetingId?: string | null;
  sourceMode?: NativeCaptureSourceMode | string | null;
  resolvedAudioSource?: number | null;
  chunkIndex?: number;
  bytesWritten?: number;
  startedElapsedMs?: number | null;
  lastProgressAtMs?: number | null;
  lastError?: string | null;
  operationId?: number | null;
  routeRestartCount?: number;
  routeRecoveryActive?: boolean;
  routedDeviceId?: number | null;
  routedDeviceType?: number | null;
  routedDeviceName?: string | null;
  lastRouteChangeElapsedMs?: number | null;
  captureGapMs?: number;
  pauseReason?: 'manual' | 'communication' | string | null;
  rmsDbfs?: number;
  peakDbfs?: number;
  freeStorageBytes?: number;
  storageReserveBytes?: number;
  systemDraining?: boolean;
  systemDrainReadCount?: number;
  systemRetainedResumeCount?: number;
  systemRecreationResumeCount?: number;
  systemRecoveryReason?: string | null;
  terminalPublicationState?: 'none' | 'queued' | 'running' | 'succeeded' | 'stale_superseded' | 'recovery_required';
  terminalReasonCode?: 'no_terminal_operation' | 'stop_queued' | 'stop_running' | 'stop_succeeded' | 'discard_ready_for_ack' | 'stop_stale_superseded' | 'stop_timeout_or_error';
  terminalOperationId?: number | null;
  terminalElapsedMs?: number;
  terminalDisposition?: 'save' | 'discard' | null;
  terminalMeetingId?: string | null;
  terminalReceiptSchemaVersion?: 'maina.ios-native-stop.v1' | null;
  terminalGeneration?: number | null;
  terminalSegmentCount?: number;
  terminalAudioBytes?: number;
  discardId?: string | null;
  discardReadyForAck?: boolean;
  quarantineReason?: 'legacy_terminal_disposition_missing' | null;
  recoveryAwaitingPublicSignal?: boolean;
  recoveryReasonCode?: string | null;
  platformHoldCount?: number;
  recoverySignalCount?: number;
}

export interface NativeCaptureDirectoryInspection {
  finalizedUris: string[];
  partialUris: string[];
  recoveredCount: number;
  invalidPartialCount: number;
  journalUri?: string | null;
}

export interface NativePostProcessingRequest {
  meetingId: string;
  directory: string;
  /** Re-run only failed windows from an otherwise preserved partial result. */
  forceRetry?: boolean;
  meetingStartedAt?: number;
  captureEndedAt?: number;
  wallDurationMs?: number;
  audioDurationMs?: number;
  routeRestartCount?: number;
  captureGapMs?: number;
}

export interface NativePostProcessingResult {
  meetingId: string;
  runId: string;
  state: 'running' | 'complete' | 'deferred' | string;
  active: boolean;
  meetingStartedAt: number;
  captureEndedAt?: number | null;
  durationMs: number;
  audioDurationMs: number;
  segmentCount: number;
  processedSegments: number;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  recoveryRounds: number;
  routeRestartCount: number;
  captureGapMs: number;
  /** Null only while a non-terminal native run is waiting to bind its recognizer. */
  modelId?: string | null;
  modelVersion?: string | null;
  runtimeVersion?: string | null;
  modelManifestSha256?: string | null;
  modelActivationGeneration?: number | null;
  /** Present only for a terminal result after native lifecycle binding. */
  resultId?: string;
  resultPayloadSha256?: string;
  lastError?: string | null;
  updatedAt: number;
  blocks: Array<{ sequence: number; segmentIndex: number; startedAt: number; endedAt: number; language: string; text: string }>;
}

export interface LegacyNativePostProcessingChangedEvent {
  meetingId: string;
  state: 'running' | 'complete' | 'partial' | 'deferred' | string;
  occurredAt: number;
}

export interface IOSNativePostProcessingChangedEvent {
  schemaVersion: 'maina.native-post-processing-changed.v1';
  meetingId: string;
  runId: string;
  generation: number;
  eventSequence: number;
}

export type NativePostProcessingChangedEvent =
  | LegacyNativePostProcessingChangedEvent
  | IOSNativePostProcessingChangedEvent;

export interface IOSNativePostProcessingWindowConfig {
  targetWindowMs: number;
  analysisOverlapMs: number;
  maxAttempts: number;
}

export interface IOSNativePostProcessingStartRequest {
  ownerUserId: string;
  meetingId: string;
  runId: string;
  generation: number;
  audioFingerprintSha256: string;
  windowConfig: IOSNativePostProcessingWindowConfig;
  runtimeOwnerToken: string;
}

export interface IOSNativePostProcessingReadRequest {
  ownerUserId: string;
  meetingId: string;
  runId: string;
  generation: number;
}

export interface IOSNativePostProcessingImportFence extends IOSNativePostProcessingReadRequest {
  schemaVersion: 'maina.native-post-processing-import-fence.v1';
  state: 'DURABLE';
  resultId: string;
  resultPayloadSha256: string;
  importedAt: string;
  transactionCommitSha256: string;
}

export interface IOSNativePostProcessingAudioDescriptor {
  schemaVersion: 'maina.native-post-processing-audio.v1';
  audioFingerprintSha256: string;
  audioDurationMs: number;
  segmentCount: number;
}

export interface IOSNativePostProcessingStartOutcome {
  requested: true;
  resumed: boolean;
  state: string;
  firstIncompleteWindowKey: string | null;
}

export interface NativePipelineWakeRequestedEvent {
  generation: number;
}

export type SchedulePipelineWake = (
  generation: number,
  requiresNetwork: boolean,
  notBeforeAt: number,
  scheduleRevision: number,
  previousWorkId: string | null,
  previousNotBeforeAt: number | null,
  previousScheduleRevision: number | null,
  schedulerProtocolVersion: number,
) => Promise<{
  scheduled: boolean;
  workId?: string | null;
  errorCode?: string | null;
}>;

export interface IOSPostProcessingDeferralEvent {
  requestId: string;
  meetingId: string;
  asrGeneration: number;
  occurredAt: number;
}

export interface QwenAsrStatus {
  ready: boolean;
  root: string;
  reason?: string | null;
}

export type NativeModelPackState =
  | 'unavailable'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'smoke_testing'
  | 'ready'
  | 'failed_download'
  | 'failed_verification'
  | 'failed_smoke'
  | 'rollback_pending';

export interface NativeModelPackLifecycleStatus {
  packId: 'qwen3-asr-0.6b-int8';
  packVersion: string | null;
  state: NativeModelPackState;
  bytesComplete: number;
  bytesTotal: number;
  reasonCode: string;
  platformCompatible: boolean;
}

export interface QwenAsrResult {
  outcome: 'success' | 'empty';
  text: string;
  language: string;
  processingMs: number;
  durationMs: number;
  engineId: string;
  engineVersion: string;
  windowStartMs: number;
  windowEndMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  speechExpected: boolean;
  truncationSuspected: boolean;
  tokenCount: number;
  maxNewTokens: 128;
}

export interface NativeEventSubscription {
  remove(): void;
}

export interface DiagnosticsConfig {
  enabled: boolean;
  supabaseUrl: string;
  publishableKey: string;
  bucket: string;
  appVersion: string;
  buildNumber: string;
  gitSha: string;
  device: string;
  platform: string;
  appSessionId: string;
  retentionDays: number;
}

export interface NativeDiagnosticEvent {
  eventId: string;
  occurredAt: string;
  elapsedMs: number;
  sequence: number;
  level: string;
  category: string;
  eventName: string;
  message: string;
  meetingId?: string | null;
  recordingSessionId?: string | null;
  segmentIndex?: number | null;
  durationMs?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface DiagnosticsStatus {
  enabled: boolean;
  installId: string;
  pendingEvents: number;
  pendingArtifacts: number;
  failedArtifacts: number;
  exhaustedArtifacts: number;
  retainedAudioBytes?: number | null;
  freeStorageBytes?: number | null;
  oldestPendingAt?: number | null;
  lastAttemptAt?: number | null;
  lastUploadAt?: number | null;
  lastError?: string | null;
}

export interface DiagnosticsPurgeResult {
  deletedArtifacts: number;
  deletedOutboxRecords: number;
  deletedFiles: number;
}

export interface AudioArtifactRequest {
  artifactId?: string;
  meetingId: string;
  segmentIndex: number;
  sourceUri: string;
  durationMs: number;
}

export interface TextArtifactRequest {
  artifactId?: string;
  meetingId: string;
  kind: 'transcript' | 'health-snapshot';
  content: string;
}

export interface DiagnosticRunSummary {
  runId: string;
  meetingId: string;
  startedAt: string;
  endedAt: string;
  status: string;
  wallDurationMs: number;
  audioDurationMs: number;
  expectedSegments: number;
  closedSegments: number;
  uploadedSegments: number;
  transcriptWords: number;
  recognizerRestarts: number;
  recognizerDowntimeMs: number;
  measuredGapMs: number;
  payload?: Record<string, unknown> | null;
}

interface MainaRecorderNativeModule {
  requestIOSMicrophonePermission?(): Promise<boolean>;
  getIOSAutomationScenario?(): string | null;
  addListener(
    eventName: 'onHardwareTrigger',
    listener: (event: HardwareTriggerEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: 'onAudioRouteChanged',
    listener: (event: AudioRouteChangedEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: 'onNativePostProcessingChanged',
    listener: (event: NativePostProcessingChangedEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: 'onPipelineWakeRequested',
    listener: (event: NativePipelineWakeRequestedEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: 'onIOSPostProcessingDeferralRequested',
    listener: (event: IOSPostProcessingDeferralEvent) => void,
  ): NativeEventSubscription;
  startForegroundSession(): Promise<boolean>;
  stopForegroundSession(): Promise<void>;
  armRemoteControl(): Promise<RemoteControlStatus>;
  disarmRemoteControl(): Promise<void>;
  setCaptureState(state: CaptureState): Promise<void>;
  consumeAndroidQualificationSession?(runId: string): Promise<string | null>;
  beginAndroidQualificationDiagnostics?(meetingId: string, evidenceDigest: string): Promise<boolean>;
  cancelAndroidQualificationDiagnosticsBeforeCapture?(meetingId: string, evidenceDigest: string): Promise<boolean>;
  isAndroidQualificationSessionActive?(): Promise<boolean>;
  startNativeCapture(
    meetingId: string,
    directory: string,
    sourceMode: NativeCaptureSourceMode,
    chunkDurationMs: number,
    meetingStartedAt: number,
    qualificationSession?: boolean,
    qualificationEvidenceDigest?: string | null,
  ): Promise<{ requested: boolean }>;
  pauseNativeCapture(): Promise<{ requested: boolean }>;
  resumeNativeCapture(): Promise<{ requested: boolean }>;
  stopNativeCapture(): Promise<{ requested: boolean }>;
  prepareNativeDiscard?(meetingId: string, discardId: string): {
    prepared: boolean;
    state: 'none' | 'pending' | 'ready_for_ack' | 'blocked';
    meetingId?: string;
    discardId?: string;
    directory?: string;
    qualificationEvidenceDigest?: string | null;
    generation?: number;
  };
  getPendingNativeDiscard?(): {
    state: 'none' | 'pending' | 'ready_for_ack' | 'blocked';
    meetingId?: string;
    discardId?: string;
    directory?: string;
    qualificationEvidenceDigest?: string | null;
    generation?: number;
  };
  getNativeCaptureQuarantine?(): {
    state: 'none' | 'legacy_terminal' | 'blocked';
    meetingId?: string;
    reason?: 'legacy_terminal_disposition_missing';
  };
  recoverNativeCaptureQuarantine?(meetingId: string): Promise<{ requested: boolean }>;
  abortNativeCapture(meetingId?: string, discardId?: string): Promise<{ requested: boolean }>;
  acknowledgeNativeDiscard?(meetingId: string, discardId: string): Promise<{ requested: boolean }>;
  retryNativeCaptureFinalization?(): Promise<{ requested: boolean }>;
  prepareIOSNativePostProcessingAudio?(meetingId: string, directory: string): Promise<IOSNativePostProcessingAudioDescriptor>;
  startIOSNativePostProcessing?(
    request: IOSNativePostProcessingStartRequest,
    directory: string,
  ): Promise<IOSNativePostProcessingStartOutcome>;
  readIOSNativePostProcessingResult?(request: IOSNativePostProcessingReadRequest): Promise<Record<string, unknown> | null>;
  acknowledgeIOSNativePostProcessingResult?(fence: IOSNativePostProcessingImportFence): Promise<{ acknowledged: boolean }>;
  releaseIOSNativePostProcessingAsr?(request: {
    runtimeOwnerToken: string;
    generation: number;
  }): Promise<{ released: boolean }>;
  startNativePostProcessing(request: NativePostProcessingRequest): Promise<{ requested: boolean }>;
  isNativePostProcessingServiceRunning?(): boolean;
  readNativePostProcessingResult(meetingId: string): Promise<NativePostProcessingResult | null>;
  acknowledgeNativePostProcessingResult(meetingId: string, runId: string): Promise<{ acknowledged: boolean }>;
  schedulePipelineWake: SchedulePipelineWake;
  completePipelineWake(attemptToken: string, succeeded: boolean): Promise<{ completed: boolean }>;
  isPipelineWakeAttemptActive(attemptToken: string): Promise<{ active: boolean }>;
  claimPendingPipelineWake?(): Promise<{
    attemptToken: string;
    wakeKind: 'shared';
    generation: number;
  } | null>;
  getNativeCaptureStatus(): NativeCaptureStatus;
  getNativeCaptureStatusAsync?(): Promise<NativeCaptureStatus>;
  inspectNativeCaptureDirectory(directory: string, recoverPartials: boolean): Promise<NativeCaptureDirectoryInspection>;
  deleteNativeCaptureDirectory(directory: string): Promise<boolean>;
  deleteNativeDiscardDirectory?(meetingId: string, directory: string): Promise<boolean>;
  getQwenAsrStatus(): Promise<QwenAsrStatus>;
  getNativeModelPackLifecycleStatus(): Promise<NativeModelPackLifecycleStatus>;
  beginNativeModelPackAcquisition(
    manifestJson: string,
    partialOverheadBytes: number,
    safetyMarginBytes: number,
  ): Promise<NativeModelPackLifecycleStatus>;
  stageNativeModelPackChunk(
    manifestJson: string,
    relativePath: string,
    chunkIndex: number,
    sourceUri: string,
  ): Promise<NativeModelPackLifecycleStatus>;
  verifyAndPromoteNativeModelPack(
    manifestJson: string,
    smokeInputUri: string,
  ): Promise<NativeModelPackLifecycleStatus>;
  transcribeWithQwen(uri: string, startMs: number, endMs: number): Promise<QwenAsrResult>;
  releaseQwenAsr(): Promise<void>;
  beginIOSContinuedProcessing?(jobId: string, title: string, subtitle: string, totalUnits: number): {
    started: boolean;
    mode: string;
    reason?: string;
    requestId?: string;
  };
  bindIOSContinuedProcessingRun?(requestId: string, meetingId: string, asrGeneration: number): boolean;
  updateIOSContinuedProcessing?(requestId: string, completedUnits: number, totalUnits: number, subtitle?: string | null): void;
  finishIOSContinuedProcessing?(requestId: string, success: boolean): void;
  acknowledgeIOSContinuedProcessingDeferral?(requestId: string, meetingId: string, asrGeneration: number): boolean;
  isIOSContinuedProcessingActive?(requestId: string, meetingId: string): boolean;
  getRemoteControlStatus(): Promise<RemoteControlStatus>;
  openRemoteAccessibilitySettings(): Promise<void>;
  acknowledgeHardwareTrigger(commandId: string, action: string, accepted: boolean): Promise<void>;
  isForegroundSessionRunning(): boolean;
  repairWavFiles(uris: string[]): Promise<number>;
  getPcmWavDurationsMs(uris: string[]): Promise<Record<string, number | null>>;
  getAudioInputs(): Promise<AudioInput[]>;
  configureDiagnostics(config: DiagnosticsConfig): Promise<DiagnosticsStatus>;
  enqueueDiagnosticEvents(events: NativeDiagnosticEvent[]): Promise<number>;
  queueAudioArtifact(request: AudioArtifactRequest): Promise<string>;
  queueTextArtifact(request: TextArtifactRequest): Promise<string>;
  finalizeDiagnosticRun(summary: DiagnosticRunSummary): Promise<void>;
  flushDiagnostics(): Promise<void>;
  retryFailedDiagnosticArtifacts(): Promise<number>;
  getDiagnosticsStatus(): Promise<DiagnosticsStatus>;
  getMeetingsWithDeletedAudio(): Promise<string[]>;
  purgeDiagnosticsData(): Promise<DiagnosticsPurgeResult>;
}

export const MainaRecorder =
  requireOptionalNativeModule<MainaRecorderNativeModule>('MainaRecorder');
