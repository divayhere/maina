import { DEFAULT_PROVIDER_ID, getProvider } from '../core/summarization/providers';
import { getSetting, setSetting } from '../data/settings';

const KEY_APP_CONFIG = 'app_config_v1';
const providerSettingsKey = (providerId: string) => `provider_settings_v1:${providerId}`;

export interface AppConfig {
  autoSummarize: boolean;
  keepAudioAfterTranscript: boolean;
  providerId: string;
  exportFormat: 'md';
  audioRetentionDays: number;
  audioRetentionMaxBytes: number;
}

export interface ProviderSettings {
  providerId: string;
  apiKey: string;
  model: string;
  customBaseUrl?: string;
}

export const DEFAULT_CONFIG: AppConfig = {
  autoSummarize: true,
  keepAudioAfterTranscript: true,
  providerId: DEFAULT_PROVIDER_ID,
  exportFormat: 'md',
  audioRetentionDays: 7,
  audioRetentionMaxBytes: 1024 * 1024 * 1024,
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
    providerId: value?.providerId ?? DEFAULT_CONFIG.providerId,
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

export async function getProviderSettings(providerId: string): Promise<ProviderSettings> {
  const provider = getProvider(providerId);
  const raw = await getSetting(providerSettingsKey(providerId));
  const parsed = safeParse<ProviderSettings>(raw);
  return {
    providerId,
    apiKey: parsed?.apiKey ?? '',
    model: parsed?.model ?? provider?.defaultModel ?? '',
    customBaseUrl: parsed?.customBaseUrl ?? provider?.baseUrl ?? '',
  };
}

export async function saveProviderSettings(
  providerId: string,
  patch: Partial<ProviderSettings>,
): Promise<ProviderSettings> {
  const current = await getProviderSettings(providerId);
  const next: ProviderSettings = {
    providerId,
    apiKey: patch.apiKey ?? current.apiKey,
    model: patch.model ?? current.model,
    customBaseUrl: patch.customBaseUrl ?? current.customBaseUrl ?? '',
  };
  await setSetting(providerSettingsKey(providerId), JSON.stringify(next));
  return next;
}

export async function hasProviderKey(providerId: string): Promise<boolean> {
  const settings = await getProviderSettings(providerId);
  return settings.apiKey.trim().length > 0;
}
