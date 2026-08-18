import { requireOptionalNativeModule } from 'expo';

export interface AudioInput {
  id: number;
  name: string;
  type: string;
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
  lastUploadAt?: number | null;
  lastError?: string | null;
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
  startForegroundSession(): Promise<boolean>;
  stopForegroundSession(): Promise<void>;
  isForegroundSessionRunning(): boolean;
  repairWavFiles(uris: string[]): Promise<number>;
  getAudioInputs(): Promise<AudioInput[]>;
  configureDiagnostics(config: DiagnosticsConfig): Promise<DiagnosticsStatus>;
  enqueueDiagnosticEvents(events: NativeDiagnosticEvent[]): Promise<number>;
  queueAudioArtifact(request: AudioArtifactRequest): Promise<string>;
  queueTextArtifact(request: TextArtifactRequest): Promise<string>;
  finalizeDiagnosticRun(summary: DiagnosticRunSummary): Promise<void>;
  flushDiagnostics(): Promise<void>;
  getDiagnosticsStatus(): Promise<DiagnosticsStatus>;
  getMeetingsWithDeletedAudio(): Promise<string[]>;
}

export const MainaRecorder =
  requireOptionalNativeModule<MainaRecorderNativeModule>('MainaRecorder');
