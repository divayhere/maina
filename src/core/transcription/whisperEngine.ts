/**
 * TranscriptionEngine backed by whisper.rn (on-device). Owns model download
 * (robust: temp file → verify size → move into place; partials deleted) and
 * caching. Swap-seam implementation.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { initWhisper, type WhisperContext } from 'whisper.rn';

import { log } from '../../services/logger';
import { DEFAULT_MODEL_ID, resolveModel } from './models';
import type { TranscribeOptions, TranscriptionEngine, TranscriptionResult } from './types';

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

/** Downloaded AND complete (guards against a half-downloaded partial). */
export async function isModelDownloaded(id: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(modelPath(id));
  if (!info.exists) return false;
  const size = (info as { size?: number }).size ?? 0;
  const expected = resolveModel(id).approxBytes;
  return size >= expected * 0.95;
}

/** Robust download: temp file, verify, move into place; delete partials on failure. */
export async function downloadModel(id: string, onProgress?: (fraction: number) => void): Promise<void> {
  if (await isModelDownloaded(id)) return;
  await ensureDir();
  const model = resolveModel(id);
  const finalPath = modelPath(id);
  const partPath = `${finalPath}.part`;

  // Clear any previous partial/corrupt file.
  await FileSystem.deleteAsync(partPath, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(finalPath, { idempotent: true }).catch(() => {});

  log.info('whisper', 'model download start', { id, url: model.url });
  const resumable = FileSystem.createDownloadResumable(model.url, partPath, {}, (p) => {
    const expected = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : model.approxBytes;
    onProgress?.(Math.min(1, p.totalBytesWritten / expected));
  });

  const result = await resumable.downloadAsync();
  if (!result) throw new Error('download-returned-nothing');

  const info = await FileSystem.getInfoAsync(partPath);
  const size = info.exists ? (info as { size?: number }).size ?? 0 : 0;
  if (size < model.approxBytes * 0.95) {
    await FileSystem.deleteAsync(partPath, { idempotent: true }).catch(() => {});
    throw new Error(`download-incomplete (${size}/${model.approxBytes})`);
  }

  await FileSystem.moveAsync({ from: partPath, to: finalPath });
  log.info('whisper', 'model download done', { id, bytes: size });
}

let context: WhisperContext | null = null;
let loadedModelId: string | null = null;

class WhisperRnEngine implements TranscriptionEngine {
  readonly id = 'whisper.rn';
  readonly label = 'Whisper (on-device)';
  modelId = DEFAULT_MODEL_ID;

  async init(): Promise<void> {
    if (!(await isModelDownloaded(this.modelId))) throw new Error('model-not-downloaded');
    if (context && loadedModelId === this.modelId) return;
    if (context) await this.dispose();
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
    return {
      text: res.result.trim(),
      segments: res.segments.map((s: { text: string; t0: number; t1: number }) => ({
        startMs: s.t0 * 10,
        endMs: s.t1 * 10,
        text: s.text.trim(),
      })),
      language: res.language,
      durationMs: Date.now() - started,
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
