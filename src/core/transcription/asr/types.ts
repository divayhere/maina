/**
 * Model-neutral contract for Maina's post-capture local-ASR engines.
 * Capture and meeting persistence must not depend on a concrete model.
 */

export type AsrAttemptReason = 'primary' | 'retry' | 'manual-reprocess';
export type AsrOutcome = 'success' | 'empty' | 'failed' | 'suspicious';

export interface AudioWindow {
  meetingId: string;
  recordingId: string;
  chunkId: string;
  sourceUri: string;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  sampleRateHz: number;
  channels: number;
  sourceRoute?: string | null;
}

export interface AsrRequest {
  engineId: string;
  engineVersion: string;
  window: AudioWindow;
  languageHint: 'auto';
  attempt: number;
  reason: AsrAttemptReason;
}

export interface AsrDiagnostics {
  modelPackId: string;
  modelPackVersion: string;
  peakMemoryMb?: number | null;
  truncationSuspected: boolean;
  repetitionSuspected: boolean;
  speechExpected: boolean;
  errorCode?: string | null;
}

export interface AsrResult {
  request: AsrRequest;
  outcome: AsrOutcome;
  text: string;
  language?: string | null;
  startedAtMs: number;
  endedAtMs: number;
  processingMs: number;
  diagnostics: AsrDiagnostics;
}

export interface LocalAsrEngine {
  readonly id: string;
  readonly version: string;
  isReady(): Promise<{ ready: boolean; reason?: string }>;
  transcribe(request: AsrRequest): Promise<AsrResult>;
}

export interface AsrEngineRegistry {
  get(engineId: string): LocalAsrEngine | null;
  list(): LocalAsrEngine[];
}

