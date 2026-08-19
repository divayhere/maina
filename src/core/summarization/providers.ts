/**
 * SWAP-SEAM: AI provider registry.
 * Add a provider by adding an entry here — most share the OpenAI-compatible
 * shape, so Grok/DeepSeek/OpenAI reuse one adapter; Anthropic and Gemini have
 * their own. The Settings screen renders this list into the provider dropdown.
 */

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';

export interface AIProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Base URL for openai-compatible providers. */
  baseUrl?: string;
  /** Where the user gets a key (shown as a helper link in Settings). */
  keyUrl: string;
  /** Suggested default model; user can override. */
  defaultModel: string;
  models: string[];
  /** Free tier available → surfaced as "₹0 to start". */
  hasFreeTier: boolean;
}

export const PROVIDERS: AIProvider[] = [
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-3.7-flash',
    models: [
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    hasFreeTier: true,
  },
  {
    id: 'openai',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'],
    hasFreeTier: false,
  },
  {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-sonnet-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    hasFreeTier: false,
  },
  {
    id: 'grok',
    label: 'Grok (xAI)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai',
    defaultModel: 'grok-4',
    models: ['grok-4', 'grok-4-fast'],
    hasFreeTier: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hasFreeTier: false,
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai-compatible',
    baseUrl: '',
    keyUrl: '',
    defaultModel: 'custom-model',
    models: [],
    hasFreeTier: false,
  },
];

export const DEFAULT_PROVIDER_ID = 'gemini';

export const getProvider = (id: string): AIProvider | undefined =>
  PROVIDERS.find((p) => p.id === id);
