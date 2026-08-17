/**
 * Whisper ggml model registry (on-device). Swap-seam: add/replace models here.
 * Files are downloaded on demand from the whisper.cpp repo to app storage.
 * Multilingual models handle English + Hindi + Hinglish code-switching.
 */
export interface WhisperModel {
  id: string;
  label: string;
  url: string;
  approxBytes: number;
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const WHISPER_MODELS: Record<string, WhisperModel> = {
  base: {
    id: 'base',
    label: 'Base · multilingual · ~148 MB',
    url: `${HF}/ggml-base.bin`,
    approxBytes: 148_000_000,
  },
  small: {
    id: 'small',
    label: 'Small · multilingual · ~488 MB (better Hindi)',
    url: `${HF}/ggml-small.bin`,
    approxBytes: 488_000_000,
  },
};

export const DEFAULT_MODEL_ID = 'base';

export function resolveModel(id: string): WhisperModel {
  return WHISPER_MODELS[id] ?? WHISPER_MODELS[DEFAULT_MODEL_ID];
}
