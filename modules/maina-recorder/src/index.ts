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
  rmsDbfs?: number;
  peakDbfs?: number;
  freeStorageBytes?: number;
  storageReserveBytes?: number;
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
  routeRestartCount: number;
  captureGapMs: number;
  lastError?: string | null;
  updatedAt: number;
  blocks: Array<{ sequence: number; segmentIndex: number; startedAt: number; endedAt: number; language: string; text: string }>;
}

export interface NativePostProcessingChangedEvent {
  meetingId: string;
  state: 'running' | 'complete' | 'partial' | 'deferred' | string;
  occurredAt: number;
}

export interface QwenAsrStatus {
  ready: boolean;
  root: string;
  reason?: string | null;
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
  startForegroundSession(): Promise<boolean>;
  stopForegroundSession(): Promise<void>;
  armRemoteControl(): Promise<RemoteControlStatus>;
  disarmRemoteControl(): Promise<void>;
  setCaptureState(state: CaptureState): Promise<void>;
  startNativeCapture(
    meetingId: string,
    directory: string,
    sourceMode: NativeCaptureSourceMode,
    chunkDurationMs: number,
    meetingStartedAt: number,
  ): Promise<{ requested: boolean }>;
  pauseNativeCapture(): Promise<{ requested: boolean }>;
  resumeNativeCapture(): Promise<{ requested: boolean }>;
  stopNativeCapture(): Promise<{ requested: boolean }>;
  abortNativeCapture(): Promise<{ requested: boolean }>;
  startNativePostProcessing(request: NativePostProcessingRequest): Promise<{ requested: boolean }>;
  readNativePostProcessingResult(meetingId: string): Promise<NativePostProcessingResult | null>;
  acknowledgeNativePostProcessingResult(meetingId: string, runId: string): Promise<{ acknowledged: boolean }>;
  getNativeCaptureStatus(): NativeCaptureStatus;
  getNativeCaptureStatusAsync?(): Promise<NativeCaptureStatus>;
  inspectNativeCaptureDirectory(directory: string, recoverPartials: boolean): Promise<NativeCaptureDirectoryInspection>;
  deleteNativeCaptureDirectory(directory: string): Promise<boolean>;
  getQwenAsrStatus(): Promise<QwenAsrStatus>;
  transcribeWithQwen(uri: string, startMs: number, endMs: number): Promise<QwenAsrResult>;
  releaseQwenAsr(): Promise<void>;
  beginIOSContinuedProcessing?(jobId: string, title: string, subtitle: string, totalUnits: number): { started: boolean; mode: string; reason?: string; requestId?: string };
  updateIOSContinuedProcessing?(completedUnits: number, totalUnits: number, subtitle?: string | null): void;
  finishIOSContinuedProcessing?(success: boolean): void;
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
