import * as SecureStore from 'expo-secure-store';

import { deleteSetting } from '@/data/settings';
import {
  classifyHttpFailure,
  safeCloudFailureMessage,
} from '@/core/pipeline/cloudFailure';
import { clearMkcMemoryCacheForOwner } from '@/services/mkc-memory-cache';
import { log } from '@/services/logger';
import {
  MainaCloudApiError,
  rejectedMainaCloudResponse,
  requestMainaCloudJson,
  type MainaCloudJsonResponse,
} from '@/services/mainaCloudTransport';

const SESSION_KEY = 'maina_cloud_session_v1';
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

/**
 * Pairing codes are opaque, case-sensitive credentials. Display the exact
 * server value so an owner can approve the same credential the phone holds.
 */
export function formatMainaCloudPairingCode(value: string) {
  return value;
}

export { MainaCloudApiError } from '@/services/mainaCloudTransport';

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
  const session = parseStoredSession(await SecureStore.getItemAsync(SESSION_KEY));
  await SecureStore.deleteItemAsync(SESSION_KEY);
  if (session?.user.userId) {
    try {
      await clearMkcMemoryCacheForOwner(session.user.userId);
    } catch (cause) {
      // Token removal must never be rolled back by a disposable-cache failure.
      log.warn('maina-cloud-session', 'owner memory cache cleanup did not complete', {
        causeName: cause instanceof Error ? cause.name : typeof cause,
      });
    }
  }
}

export async function mainaCloudRequestJson(
  path: string,
  init: RequestInit = {},
  options?: { acceptHttpErrors?: boolean },
): Promise<MainaCloudJsonResponse> {
  const session = await getMainaCloudSession();
  if (!session) {
    throw new MainaCloudApiError(
      'Maina Cloud is not connected on this phone.',
      401,
      'cloud_session_missing',
      'auth',
    );
  }
  const response = await requestMainaCloudJson({
    url: `${apiBaseUrl()}${path}`,
    init: {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
        ...init.headers,
      },
    },
  });
  if (!response.ok && options?.acceptHttpErrors !== true) {
    const failure = rejectedMainaCloudResponse(response);
    if (response.status === 401 || response.status === 403) {
      // Preserve nothing but an opaque expired token; no local meeting state
      // is mutated here. The caller maps this to an auth-blocked cloud job.
      await clearMainaCloudSession();
    }
    log.warn('maina-cloud-session', 'authenticated cloud request was rejected', {
      status: response.status,
      code: failure.code ?? null,
      failureClass: failure.failureClass,
    });
    throw failure;
  }
  return response;
}

export async function createMainaCloudPairing(deviceLabel: string): Promise<MainaCloudPairingRequest> {
  const response = await requestMainaCloudJson({
    url: `${apiBaseUrl()}/v1/mobile/pairings`,
    init: {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_label: deviceLabel.trim() || 'Maina mobile' }),
    },
  });
  const body = response.data as {
    pairing_id?: unknown;
    verification_code?: unknown;
    expires_at?: unknown;
  };
  if (!response.ok || typeof body.pairing_id !== 'string' || typeof body.verification_code !== 'string' || typeof body.expires_at !== 'string') {
    const failure = apiMessage(body, 'Could not start Maina Cloud pairing.');
    const failureClass = classifyHttpFailure(response.status, failure.code);
    throw new MainaCloudApiError(safeCloudFailureMessage(failureClass), response.status, failure.code, failureClass);
  }
  return { pairingId: body.pairing_id, verificationCode: body.verification_code, expiresAt: body.expires_at };
}

export async function exchangeMainaCloudPairing(input: MainaCloudPairingRequest): Promise<MainaCloudSession> {
  const response = await requestMainaCloudJson({
    url: `${apiBaseUrl()}/v1/mobile/pairings/${encodeURIComponent(input.pairingId)}/exchange`,
    init: {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ verification_code: input.verificationCode }),
    },
  });
  const body = response.data as {
    access_token?: unknown;
    expires_at?: unknown;
    user?: { id?: unknown; user_id?: unknown; email?: unknown; display_name?: unknown; role?: unknown };
  };
  const userId = typeof body.user?.id === 'string'
    ? body.user.id
    : typeof body.user?.user_id === 'string'
      ? body.user.user_id
      : null;
  if (!response.ok || typeof body.access_token !== 'string' || !userId || typeof body.user?.email !== 'string') {
    const failure = apiMessage(body, 'Maina Cloud pairing was not approved yet.');
    const failureClass = classifyHttpFailure(response.status, failure.code);
    throw new MainaCloudApiError(safeCloudFailureMessage(failureClass), response.status, failure.code, failureClass);
  }
  const session: MainaCloudSession = {
    accessToken: body.access_token,
    expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    user: {
      userId,
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
    await mainaCloudRequestJson('/v1/auth/logout', { method: 'POST' });
  } catch (cause) {
    // Local removal is the important safety behavior: revoked/expired remote
    // sessions and unreachable networks must both leave the phone signed out.
    log.warn('maina-cloud-session', 'remote session logout did not complete', {
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
  } finally {
    await clearMainaCloudSession();
  }
}

export async function getMainaCloudConnection(): Promise<MainaCloudSession | null> {
  const session = await getMainaCloudSession();
  if (!session) return null;
  try {
    const response = await mainaCloudRequestJson('/v1/auth/me');
    const body = response.data as {
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
