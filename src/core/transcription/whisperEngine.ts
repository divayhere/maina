/**
 * TranscriptionEngine implementation backed by whisper.rn (on-device).
 * Also owns model download/caching. This is the swap-seam implementation:
 * a future engine just needs to satisfy TranscriptionEngine.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { initWhisper, type WhisperContext } from 'whisper.rn';

import { log } from '../../services/logger';
import type { TranscribeOptions, TranscriptionEngine, TranscriptionResult } from './types';
import { DEFAULT_MODEL_ID, resolveModel } from './models';

const MODEL_DIR = `${FileSystem.documentDirectory}models/`;

function modelPath(id: string): string {
  return `${MODEL_DIR}ggml-${id}.bin`;
}

/** whisper.rn wants a plain filesystem path, not Expo's file:// URI. */
function nativePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODEL_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
}

export async function isModelDownloaded(id: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(modelPath(id));
  return info.exists && (info.size ?? 0) > 1_000_000;
}

/** Download a model with progress (0..1). Idempotent. */
export async function downloadModel(id: string, onProgress?: (fraction: number) => void): Promise<void> {
  if (await isModelDownloaded(id)) return;
  await ensureDir();
  const model = resolveModel(id);
  log.info('whisper', 'model download start', { id, url: model.url });
  const resumable = FileSystem.createDownloadResumable(
    model.url,
    modelPath(id),
    {},
    (p) => {
      const expected = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : model.approxBytes;
      onProgress?.(Math.min(1, p.totalBytesWritten / expected));
    },
  );
  await resumable.downloadAsync();
  log.info('whisper', 'model download done', { id });
}

let context: WhisperContext | null = null;
let loadedModelId: string | null = null;

class WhisperRnEngine implements TranscriptionEngine {
  readonly id = 'whisper.rn';
  readonly label = 'Whisper (on-device)';
  modelId = DEFAULT_MODEL_ID;

  async init(): Promise<void> {
    if (!(await isModelDownloaded(this.modelId))) {
      throw new Error('model-not-downloaded');
    }
    if (context && loadedModelId === this.modelId) return;
    if (context) {
      await this.dispose();
    }
    context = await initWhisper({ filePath: nativePath(modelPath(this.modelId)), useGpu: true });
    loadedModelId = this.modelId;
    log.info('whisper', 'context ready', { model: this.modelId });
  }

  async transcribe(audioPath: string, opts?: TranscribeOptions): Promise<TranscriptionResult> {
    await this.init();
    const started = Date.now();
    const { promise } = context!.transcribe(nativePath(audioPath), {
      language: opts?.language ?? 'auto',
      maxThreads: 6,
    });
    const res = await promise;
    const durationMs = Date.now() - started;
    log.info('whisper', 'transcribed', { chars: res.result.length, lang: res.language, ms: durationMs });
    return {
      text: res.result.trim(),
      // whisper segment times are in centiseconds (10ms units).
      segments: res.segments.map((s: { text: string; t0: number; t1: number }) => ({
        startMs: s.t0 * 10,
        endMs: s.t1 * 10,
        text: s.text.trim(),
      })),
      language: res.language,
      durationMs,
      engineId: this.id,
    };
  }

  async dispose(): Promise<void> {
    if (context) {
      try {
        await context.release();
      } catch (e) {
        log.warn('whisper', 'release failed', { err: String(e) });
      }
      context = null;
      loadedModelId = null;
    }
  }
}

export const whisperEngine = new WhisperRnEngine();
