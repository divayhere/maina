/**
 * Whisper ggml model registry (on-device). One local model, chosen for
 * accuracy-with-reliability on a Pixel 9 Pro: large-v3-turbo quantized (q5_0).
 * Strong Hindi/English, ~547 MB (much more reliable to download than the 1.6 GB
 * full turbo), runs fully offline.
 */
export interface WhisperModel {
  id: string;
  label: string;
  hint: string;
  url: string;
  approxBytes: number;
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const LOCAL_MODEL: WhisperModel = {
  id: 'large-v3-turbo-q5_0',
  label: 'Large v3 Turbo (quantized)',
  hint: '~547 MB · strong Hindi + English · offline',
  url: `${HF}/ggml-large-v3-turbo-q5_0.bin`,
  approxBytes: 547_000_000,
};

export const WHISPER_MODELS: Record<string, WhisperModel> = {
  [LOCAL_MODEL.id]: LOCAL_MODEL,
};

export const DEFAULT_MODEL_ID = LOCAL_MODEL.id;

export function resolveModel(id: string): WhisperModel {
  return WHISPER_MODELS[id] ?? LOCAL_MODEL;
}
