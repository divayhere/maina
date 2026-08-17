/**
 * App config / feature flags — behaviours that change without touching code.
 * Persisted to storage in a later phase; these are the defaults.
 */

import { DEFAULT_PROVIDER_ID } from '../core/summarization/providers';

export interface AppConfig {
  /** On = summary + to-dos generated the moment recording stops. */
  autoSummarize: boolean;
  /** Audio wiped as soon as the transcript is saved. */
  audioAutoDelete: boolean;
  /** Default transcription language; "auto" handles Hinglish. */
  transcriptionLanguage: 'auto' | 'en' | 'hi';
  /** Which whisper.rn model to load. */
  transcriptionModel: string;
  /** Selected AI provider id (see providers.ts). */
  providerId: string;
  /** Preferred export format. */
  exportFormat: 'md' | 'txt';
}

export const DEFAULT_CONFIG: AppConfig = {
  autoSummarize: true,
  audioAutoDelete: true,
  transcriptionLanguage: 'auto',
  transcriptionModel: 'whisper-large-v3-turbo',
  providerId: DEFAULT_PROVIDER_ID,
  exportFormat: 'md',
};
