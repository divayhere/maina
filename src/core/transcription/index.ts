/**
 * Transcription factory (swap-seam entry point). The app asks for "the engine"
 * and never names an implementation — swap whisper.rn for anything else here.
 */
import type { TranscriptionEngine } from './types';
import { whisperEngine } from './whisperEngine';

export function getTranscriptionEngine(): TranscriptionEngine {
  return whisperEngine;
}

/** Point the engine at a specific model id before init/transcribe. */
export function setTranscriptionModel(id: string): void {
  whisperEngine.modelId = id;
}

export * from './types';
export { downloadModel, isModelDownloaded } from './whisperEngine';
export { transcribeMeeting } from './transcribeMeeting';
export { WHISPER_MODELS, resolveModel, DEFAULT_MODEL_ID, LOCAL_MODEL } from './models';
