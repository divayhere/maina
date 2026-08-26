import { deleteSetting, getSetting, setSetting } from '../data/settings';
import { getMainaCloudSession } from './mainaCloudSession';

const KEY_APP_CONFIG = 'app_config_v1';
const LEGACY_MAINA_KNOWLEDGE_CLOUD_SETTINGS = 'maina_knowledge_cloud_settings_v1';

export interface AppConfig {
  autoSummarize: boolean;
  keepAudioAfterTranscript: boolean;
  exportFormat: 'md';
  audioRetentionDays: number;
  audioRetentionMaxBytes: number;
}

export interface MainaKnowledgeCloudSettings {
  enabled: boolean;
  baseUrl: string;
  token: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  autoSummarize: true,
  keepAudioAfterTranscript: true,
  exportFormat: 'md',
  audioRetentionDays: 7,
  audioRetentionMaxBytes: 1024 * 1024 * 1024,
};

export const DEFAULT_MAINA_KNOWLEDGE_CLOUD_SETTINGS: MainaKnowledgeCloudSettings = {
  enabled: false,
  baseUrl: process.env.EXPO_PUBLIC_MKC_BASE_URL?.trim().replace(/\/+$/, '')
    || 'https://mkc-backend.maina-knowledge-cloud.workers.dev',
  token: '',
};

function safeParse<T>(value: string | null): Partial<T> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Partial<T>;
  } catch {
    return null;
  }
}

function normalizeConfig(value?: Partial<AppConfig> | null): AppConfig {
  return {
    autoSummarize: value?.autoSummarize ?? DEFAULT_CONFIG.autoSummarize,
    keepAudioAfterTranscript: value?.keepAudioAfterTranscript ?? DEFAULT_CONFIG.keepAudioAfterTranscript,
    exportFormat: 'md',
    audioRetentionDays: value?.audioRetentionDays ?? DEFAULT_CONFIG.audioRetentionDays,
    audioRetentionMaxBytes: value?.audioRetentionMaxBytes ?? DEFAULT_CONFIG.audioRetentionMaxBytes,
  };
}

export async function getAppConfig(): Promise<AppConfig> {
  const raw = await getSetting(KEY_APP_CONFIG);
  return normalizeConfig(safeParse<AppConfig>(raw));
}

export async function saveAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await getAppConfig();
  const next = normalizeConfig({ ...current, ...patch });
  await setSetting(KEY_APP_CONFIG, JSON.stringify(next));
  return next;
}

export async function getMainaKnowledgeCloudSettings(): Promise<MainaKnowledgeCloudSettings> {
  const session = await getMainaCloudSession();
  return {
    enabled: !!session,
    baseUrl: DEFAULT_MAINA_KNOWLEDGE_CLOUD_SETTINGS.baseUrl,
    token: session?.accessToken ?? '',
  };
}

/**
 * Deprecated compatibility shim. Cloud connection is now established only by
 * the scoped pairing session; URLs and tokens are never saved from Settings.
 */
export async function saveMainaKnowledgeCloudSettings(
  _patch: Partial<MainaKnowledgeCloudSettings>,
): Promise<MainaKnowledgeCloudSettings> {
  return getMainaKnowledgeCloudSettings();
}

/** Clear old direct-provider and direct-MKC configuration once pairing succeeds. */
export async function clearLegacyDirectAiConfiguration(): Promise<void> {
  await Promise.all([
    deleteSetting(LEGACY_MAINA_KNOWLEDGE_CLOUD_SETTINGS),
    ...['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'custom'].map((providerId) =>
      deleteSetting(`provider_settings_v1:${providerId}`),
    ),
  ]);
}
