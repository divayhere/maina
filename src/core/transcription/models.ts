/**
 * Whisper ggml model registry (on-device). Swap-seam: add/replace models here.
 * Files are downloaded on demand from the whisper.cpp repo to app storage.
 * Multilingual models handle English + Hindi + Hinglish code-switching — but
 * Hindi quality scales strongly with model size (base is too weak for Hindi).
 */
export interface WhisperModel {
  id: string;
  label: string;
  hint: string;
  url: string;
  approxBytes: number;
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const WHISPER_MODELS: Record<string, WhisperModel> = {
  base: {
    id: 'base',
    label: 'Base',
    hint: '~148 MB · fastest · weak Hindi',
    url: `${HF}/ggml-base.bin`,
    approxBytes: 148_000_000,
  },
  small: {
    id: 'small',
    label: 'Small',
    hint: '~488 MB · good balance · decent Hindi',
    url: `${HF}/ggml-small.bin`,
    approxBytes: 488_000_000,
  },
  medium: {
    id: 'medium',
    label: 'Medium',
    hint: '~1.5 GB · slower · strong Hindi',
    url: `${HF}/ggml-medium.bin`,
    approxBytes: 1_530_000_000,
  },
  'large-v3-turbo': {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo',
    hint: '~1.6 GB · best Hindi · fast for its size',
    url: `${HF}/ggml-large-v3-turbo.bin`,
    approxBytes: 1_620_000_000,
  },
};

export const MODEL_ORDER = ['base', 'small', 'medium', 'large-v3-turbo'];

export const DEFAULT_MODEL_ID = 'small';

export function resolveModel(id: string): WhisperModel {
  return WHISPER_MODELS[id] ?? WHISPER_MODELS[DEFAULT_MODEL_ID];
}
