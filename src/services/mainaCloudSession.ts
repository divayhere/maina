import * as SecureStore from 'expo-secure-store';

import { deleteSetting } from '@/data/settings';
import { log } from '@/services/logger';

const SESSION_KEY = 'maina_cloud_session_v1';
const REQUEST_TIMEOUT_MS = 20_000;
const MAINAKC_BASE_URL = process.env.EXPO_PUBLIC_MKC_BASE_URL?.trim().replace(/\/+$/, '')
  || 'https://mkc-backend.maina-knowledge-cloud.workers.dev';

export type MainaCloudUser = {
  userId: string;
  email: string;
  displayName?: string | null;
  role?: string | null;
};

export type MainaCloudSession = {
  accessToken: string;
  expiresAt?: string | null;
  user: MainaCloudUser;
};

export type MainaCloudPairingRequest = {
  pairingId: string;
  verificationCode: string;
  expiresAt: string;
};

export class MainaCloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'MainaCloudApiError';
  }
}

function apiBaseUrl() {
  return MAINAKC_BASE_URL;
}

function parseStoredSession(value: string | null): MainaCloudSession | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MainaCloudSession>;
    if (!parsed.accessToken?.trim() || !parsed.user?.userId || !parsed.user.email) return null;
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt ?? null,
      user: {
        userId: parsed.user.userId,
        email: parsed.user.email,
        displayName: parsed.user.displayName ?? null,
        role: parsed.user.role ?? null,
      },
    };
  } catch {
    return null;
  }
}

function isExpired(expiresAt?: string | null) {
  if (!expiresAt) return false;
  const value = Date.parse(expiresAt);
  return Number.isFinite(value) && value <= Date.now() + 30_000;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

function apiMessage(body: unknown, fallback: string) {
  const candidate = body as { error?: { code?: unknown; message?: unknown } } | null;
  return {
    code: typeof candidate?.error?.code === 'string' ? candidate.error.code : undefined,
    message: typeof candidate?.error?.message === 'string' ? candidate.error.message : fallback,
  };
}

export async function getMainaCloudSession(): Promise<MainaCloudSession | null> {
  const session = parseStoredSession(await SecureStore.getItemAsync(SESSION_KEY));
  if (!session) return null;
  if (isExpired(session.expiresAt)) {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
  return session;
}

export async function saveMainaCloudSession(session: MainaCloudSession): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  // The former direct-key configuration must not stay available as a hidden
  // fallback after a scoped Cloud session is established.
  await Promise.all([
    deleteSetting('maina_knowledge_cloud_settings_v1'),
    ...['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'custom'].map((providerId) =>
      deleteSetting(`provider_settings_v1:${providerId}`),
    ),
  ]);
}

export async function clearMainaCloudSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function mainaCloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const session = await getMainaCloudSession();
  if (!session) throw new MainaCloudApiError('Maina Cloud is not connected on this phone.', 401, 'cloud_session_missing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      signal: init.signal ?? controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await readJson(response);
      const failure = apiMessage(body, `Maina Cloud request failed (${response.status})`);
      if (response.status === 401 || response.status === 403) {
        // Preserve nothing but an opaque expired token; no local meeting state
        // is mutated here. The caller maps this to an auth-blocked cloud job.
        await clearMainaCloudSession();
      }
      throw new MainaCloudApiError(failure.message, response.status, failure.code);
    }
    return response;
  } catch (cause) {
    if (cause instanceof MainaCloudApiError) throw cause;
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new MainaCloudApiError('Maina Cloud took too long to respond. Maina will retry later.', 0, 'network_timeout');
    }
    throw new MainaCloudApiError(
      cause instanceof Error ? cause.message : 'Maina Cloud is temporarily unavailable.',
      0,
      'network_error',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function createMainaCloudPairing(deviceLabel: string): Promise<MainaCloudPairingRequest> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/mobile/pairings`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_label: deviceLabel.trim() || 'Maina Android' }),
    });
    const body = await readJson(response) as {
      pairing_id?: unknown;
      verification_code?: unknown;
      expires_at?: unknown;
    };
    if (!response.ok || typeof body.pairing_id !== 'string' || typeof body.verification_code !== 'string' || typeof body.expires_at !== 'string') {
      const failure = apiMessage(body, 'Could not start Maina Cloud pairing.');
      throw new MainaCloudApiError(failure.message, response.status, failure.code);
    }
    return { pairingId: body.pairing_id, verificationCode: body.verification_code, expiresAt: body.expires_at };
  } finally {
    clearTimeout(timeout);
  }
}

export async function exchangeMainaCloudPairing(input: MainaCloudPairingRequest): Promise<MainaCloudSession> {
  const response = await fetch(`${apiBaseUrl()}/v1/mobile/pairings/${encodeURIComponent(input.pairingId)}/exchange`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ verification_code: input.verificationCode }),
  });
  const body = await readJson(response) as {
    access_token?: unknown;
    expires_at?: unknown;
    user?: { user_id?: unknown; email?: unknown; display_name?: unknown; role?: unknown };
  };
  if (!response.ok || typeof body.access_token !== 'string' || typeof body.user?.user_id !== 'string' || typeof body.user.email !== 'string') {
    const failure = apiMessage(body, 'Maina Cloud pairing was not approved yet.');
    throw new MainaCloudApiError(failure.message, response.status, failure.code);
  }
  const session: MainaCloudSession = {
    accessToken: body.access_token,
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    user: {
      userId: body.user.user_id,
      email: body.user.email,
      displayName: typeof body.user.display_name === 'string' ? body.user.display_name : null,
      role: typeof body.user.role === 'string' ? body.user.role : null,
    },
  };
  await saveMainaCloudSession(session);
  log.info('maina-cloud-session', 'mobile cloud pairing established', { userId: session.user.userId });
  return session;
}

export async function signOutMainaCloud(): Promise<void> {
  try {
    await mainaCloudFetch('/v1/auth/logout', { method: 'POST' });
  } catch (cause) {
    // Local removal is the important safety behavior: revoked/expired remote
    // sessions and unreachable networks must both leave the phone signed out.
    log.warn('maina-cloud-session', 'remote session logout did not complete', { err: String(cause) });
  } finally {
    await clearMainaCloudSession();
  }
}

export async function getMainaCloudConnection(): Promise<MainaCloudSession | null> {
  const session = await getMainaCloudSession();
  if (!session) return null;
  try {
    const response = await mainaCloudFetch('/v1/auth/me');
    const body = await readJson(response) as {
      expires_at?: unknown;
      user?: { user_id?: unknown; email?: unknown; display_name?: unknown; role?: unknown };
    };
    if (typeof body.user?.user_id === 'string' && typeof body.user.email === 'string') {
      const refreshed: MainaCloudSession = {
        ...session,
        expiresAt: typeof body.expires_at === 'string' ? body.expires_at : session.expiresAt,
        user: {
          userId: body.user.user_id,
          email: body.user.email,
          displayName: typeof body.user.display_name === 'string' ? body.user.display_name : null,
          role: typeof body.user.role === 'string' ? body.user.role : null,
        },
      };
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(refreshed));
      return refreshed;
    }
    return session;
  } catch (cause) {
    if (cause instanceof MainaCloudApiError && (cause.status === 401 || cause.status === 403)) return null;
    // A temporary offline state must not log the user out or block local work.
    return session;
  }
}
