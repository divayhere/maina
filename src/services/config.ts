/**
 * App config / feature flags — behaviours that change without touching code.
 * Persisted to storage in a later phase; these are the defaults.
 * (Speech language lives in data/settings.ts because the user can change it.)
 */

import { DEFAULT_PROVIDER_ID } from '../core/summarization/providers';

export interface AppConfig {
  /** On = summary + to-dos generated the moment recording stops. */
  autoSummarize: boolean;
  /** Keep the recorded audio after a transcript exists (safety net for a re-pass). */
  keepAudioAfterTranscript: boolean;
  /** Selected AI provider id (see providers.ts). */
  providerId: string;
  /** Preferred export format. */
  exportFormat: 'md' | 'txt';
}

export const DEFAULT_CONFIG: AppConfig = {
  autoSummarize: false,
  keepAudioAfterTranscript: true,
  providerId: DEFAULT_PROVIDER_ID,
  exportFormat: 'md',
};
