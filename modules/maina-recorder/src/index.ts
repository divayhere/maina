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

export type CaptureState = 'idle' | 'recording' | 'paused' | 'finalizing';

export interface RemoteControlStatus {
  armed: boolean;
  captureState: CaptureState;
  accessibilityEnabled: boolean;
  accessibilityConnected: boolean;
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
  addListener(
    eventName: 'onHardwareTrigger',
    listener: (event: HardwareTriggerEvent) => void,
  ): NativeEventSubscription;
  addListener(
    eventName: 'onAudioRouteChanged',
    listener: (event: AudioRouteChangedEvent) => void,
  ): NativeEventSubscription;
  startForegroundSession(): Promise<boolean>;
  stopForegroundSession(): Promise<void>;
  armRemoteControl(): Promise<RemoteControlStatus>;
  disarmRemoteControl(): Promise<void>;
  setCaptureState(state: CaptureState): Promise<void>;
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
