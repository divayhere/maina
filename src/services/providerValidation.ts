import { getProvider, type AIProvider } from '../core/summarization/providers';
import type { ProviderSettings } from './config';

export interface ProviderValidationResult {
  ok: boolean;
  message: string;
  resolvedModel?: string;
  availableModels?: string[];
  normalizedBaseUrl?: string;
}

interface JsonError {
  error?: {
    message?: string;
    details?: unknown;
    status?: string;
  };
  message?: string;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? '').trim().replace(/\/$/, '');
}

function uniqueModels(candidateIds: string[]): string[] {
  const normalized = candidateIds
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function buildModelPreferenceOrder(
  provider: AIProvider,
  candidateIds: string[],
  requestedModel?: string,
): string[] {
  const unique = uniqueModels(candidateIds);
  if (unique.length === 0) return [];

  const requested = requestedModel?.trim();
  const preferences = [
    requested,
    provider.defaultModel,
    ...provider.models,
  ].filter(Boolean) as string[];

  const ordered: string[] = [];
  for (const preferred of preferences) {
    const exact = unique.find((candidate) => candidate === preferred);
    if (exact && !ordered.includes(exact)) ordered.push(exact);
  }

  for (const preferred of preferences) {
    const partial = unique.find((candidate) => candidate.includes(preferred));
    if (partial && !ordered.includes(partial)) ordered.push(partial);
  }

  unique.forEach((candidate) => {
    if (!ordered.includes(candidate)) ordered.push(candidate);
  });

  return ordered;
}

function pickPreferredModel(provider: AIProvider, candidateIds: string[], requestedModel?: string): string | null {
  return buildModelPreferenceOrder(provider, candidateIds, requestedModel)[0] ?? null;
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  const fallback = response.statusText || `HTTP ${response.status}`;
  let parsed: JsonError | undefined;
  try {
    parsed = raw ? JSON.parse(raw) as JsonError : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message = parsed?.error?.message ?? parsed?.message ?? raw?.slice(0, 300) ?? fallback;
    throw new Error(message || fallback);
  }
  return parsed ?? {};
}

async function probeGeminiModel(apiKey: string, model: string): Promise<void> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: 'Reply with OK.' }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8,
        },
      }),
    },
  );
  await readJson(response);
}

async function validateGemini(
  provider: AIProvider,
  settings: ProviderSettings,
): Promise<ProviderValidationResult> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(settings.apiKey.trim())}`,
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const json = await readJson(response) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  const models = (json.models ?? [])
    .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((model) => String(model.name ?? '').replace(/^models\//, '').trim())
    .filter(Boolean);
  const orderedModels = buildModelPreferenceOrder(provider, models, settings.model);
  if (orderedModels.length === 0) {
    return {
      ok: false,
      message: 'The Gemini key worked, but no text-generation model was available for it.',
    };
  }

  let lastError = 'The Gemini key worked, but Maina could not find a working generation model for it.';
  for (const candidate of orderedModels.slice(0, 8)) {
    try {
      await probeGeminiModel(settings.apiKey.trim(), candidate);
      return {
        ok: true,
        message: `Gemini verified · using ${candidate}`,
        resolvedModel: candidate,
        availableModels: models,
      };
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return {
    ok: false,
    message: `Gemini key verified, but no working text model could be activated right now. Last response: ${lastError}`,
    availableModels: models,
  };
}

async function validateAnthropic(
  provider: AIProvider,
  settings: ProviderSettings,
): Promise<ProviderValidationResult> {
  const response = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': settings.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
  });
  const json = await readJson(response) as {
    data?: { id?: string }[];
  };
  const models = (json.data ?? [])
    .map((item) => String(item.id ?? '').trim())
    .filter(Boolean);
  const resolvedModel = pickPreferredModel(provider, models, settings.model);
  if (!resolvedModel) {
    return {
      ok: false,
      message: 'The Anthropic key worked, but no Claude model was available for it.',
    };
  }
  return {
    ok: true,
    message: `Claude verified · using ${resolvedModel}`,
    resolvedModel,
    availableModels: models,
  };
}

async function validateOpenAICompatible(
  provider: AIProvider,
  settings: ProviderSettings,
): Promise<ProviderValidationResult> {
  const normalizedBaseUrl = normalizeBaseUrl(settings.customBaseUrl || provider.baseUrl);
  if (!normalizedBaseUrl) {
    return {
      ok: false,
      message: 'Add the provider base URL before saving this AI setup.',
    };
  }
  const response = await fetch(`${normalizedBaseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
  });
  const json = await readJson(response) as {
    data?: { id?: string }[];
  };
  const models = (json.data ?? [])
    .map((item) => String(item.id ?? '').trim())
    .filter(Boolean);
  const resolvedModel = pickPreferredModel(provider, models, settings.model);
  if (!resolvedModel) {
    return {
      ok: false,
      message: 'The provider key worked, but no compatible model was listed for it.',
      normalizedBaseUrl,
    };
  }
  return {
    ok: true,
    message: `${provider.label} verified · using ${resolvedModel}`,
    resolvedModel,
    availableModels: models,
    normalizedBaseUrl,
  };
}

export async function validateProviderSettings(
  providerId: string,
  settings: ProviderSettings,
): Promise<ProviderValidationResult> {
  const provider = getProvider(providerId);
  if (!provider) {
    return {
      ok: false,
      message: 'Choose an AI provider before saving.',
    };
  }
  if (!settings.apiKey.trim()) {
    return {
      ok: false,
      message: 'Paste your API key before saving.',
    };
  }

  if (provider.kind === 'gemini') {
    return validateGemini(provider, settings);
  }
  if (provider.kind === 'anthropic') {
    return validateAnthropic(provider, settings);
  }
  return validateOpenAICompatible(provider, settings);
}

export const providerValidationInternal = {
  buildModelPreferenceOrder,
  normalizeBaseUrl,
  pickPreferredModel,
};
