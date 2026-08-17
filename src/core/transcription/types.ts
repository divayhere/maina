/**
 * SWAP-SEAM: Transcription engine.
 * Whisper today; a different on-device model tomorrow. Anything implementing
 * this interface can be dropped in via the registry without touching the UI,
 * database, or summarizer.
 */

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Optional diarization label, filled by a later speaker-labelling pass. */
  speaker?: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string;       // detected or forced (e.g. "en", "hi")
  durationMs: number;
  engineId: string;
}

export interface TranscribeOptions {
  /** "auto" lets the model detect; otherwise force a language code. */
  language?: 'auto' | 'en' | 'hi' | string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface TranscriptionEngine {
  readonly id: string;
  readonly label: string;
  /** Load model into memory / download if needed. Safe to call repeatedly. */
  init(): Promise<void>;
  /** Transcribe a local audio file. Must never mutate or delete the file. */
  transcribe(audioPath: string, opts?: TranscribeOptions): Promise<TranscriptionResult>;
  /** Free model memory. */
  dispose(): Promise<void>;
}
