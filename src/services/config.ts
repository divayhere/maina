/**
 * App config / feature flags — behaviours that change without touching code.
 * Persisted to storage in a later phase; these are the defaults.
 * Core speech languages are provisioned automatically by nativeSpeech.ts.
 */

import { DEFAULT_PROVIDER_ID } from '../core/summarization/providers';

export interface AppConfig {
  /** On = summary + to-dos generated the moment recording stops. */
  autoSummarize: boolean;
  /** Keep source audio until its compressed diagnostic backup and transcript are safely uploaded. */
  keepAudioAfterTranscript: boolean;
  /** Selected AI provider id (see providers.ts). */
  providerId: string;
  /** Preferred export format. */
  exportFormat: 'md' | 'txt';
}

export const DEFAULT_CONFIG: AppConfig = {
  autoSummarize: false,
  keepAudioAfterTranscript: false,
  providerId: DEFAULT_PROVIDER_ID,
  exportFormat: 'md',
};
