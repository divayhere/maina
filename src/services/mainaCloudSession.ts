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
let sessionMutationTail: Promise<void> = Promise.resolve();

export type MainaCloudUser = {
  userId: string;
  email: string;
  displayName?: string | null;
  role?: string | null;
};

export type MainaCloudSession = {
  accessToken: string;
  expiresAt?: string | null;
  scopes: string[];
  scopesVerifiedAt?: number | null;
  user: MainaCloudUser;
};

export type MainaCloudExecutionContext = Readonly<{
  ownerUserId: string;
  accessToken: string;
  scopesVerifiedAt: number;
}>;

export class MainaCloudScopeError extends Error {
  constructor(
    readonly code: 'cloud_scope_unverified' | 'cloud_scope_repair_required',
    message: string,
  ) {
    super(message);
    this.name = 'MainaCloudScopeError';
  }
}

export class MainaCloudSessionMismatchError extends Error {
  constructor() {
    super('The Maina Cloud session changed before the request could be sent.');
    this.name = 'MainaCloudSessionMismatchError';
  }
}

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
      scopes: Array.isArray(parsed.scopes)
        ? parsed.scopes.filter((scope): scope is string => typeof scope === 'string')
        : [],
      scopesVerifiedAt: typeof parsed.scopesVerifiedAt === 'number' ? parsed.scopesVerifiedAt : null,
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

function withSessionMutation<T>(task: () => Promise<T>): Promise<T> {
  const operation = sessionMutationTail.then(task, task);
  sessionMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

async function readStoredSession(): Promise<MainaCloudSession | null> {
  return parseStoredSession(await SecureStore.getItemAsync(SESSION_KEY));
}

function sameSessionCredential(
  left: MainaCloudSession | null,
  right: Pick<MainaCloudSession, 'accessToken' | 'user'>,
): left is MainaCloudSession {
  return left !== null
    && left.accessToken === right.accessToken
    && left.user.userId === right.user.userId;
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
  const session = await readStoredSession();
  if (!session) return null;
  if (isExpired(session.expiresAt)) {
    return withSessionMutation(async () => {
      const current = await readStoredSession();
      if (!current) return null;
      if (!isExpired(current.expiresAt)) return current;
      await SecureStore.deleteItemAsync(SESSION_KEY);
      return null;
    });
  }
  return session;
}

export async function saveMainaCloudSession(session: MainaCloudSession): Promise<void> {
  await withSessionMutation(() => SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session)));
  // The former direct-key configuration must not stay available as a hidden
  // fallback after a scoped Cloud session is established.
  await Promise.all([
    deleteSetting('maina_knowledge_cloud_settings_v1'),
    ...['gemini', 'openai', 'anthropic', 'grok', 'deepseek', 'custom'].map((providerId) =>
      deleteSetting(`provider_settings_v1:${providerId}`),
    ),
  ]);
}

async function clearOwnerMemoryCache(ownerUserId: string | null): Promise<void> {
  if (ownerUserId) {
    try {
      await clearMkcMemoryCacheForOwner(ownerUserId);
    } catch (cause) {
      // Token removal must never be rolled back by a disposable-cache failure.
      log.warn('maina-cloud-session', 'owner memory cache cleanup did not complete', {
        causeName: cause instanceof Error ? cause.name : typeof cause,
      });
    }
  }
}

export async function clearMainaCloudSession(): Promise<void> {
  const ownerUserId = await withSessionMutation(async () => {
    const session = await readStoredSession();
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return session?.user.userId ?? null;
  });
  await clearOwnerMemoryCache(ownerUserId);
}

function sessionMatchesExecutionContext(
  session: MainaCloudSession | null,
  context: MainaCloudExecutionContext,
): session is MainaCloudSession {
  return session !== null
    && session.user.userId === context.ownerUserId
    && session.accessToken === context.accessToken
    && session.scopesVerifiedAt === context.scopesVerifiedAt;
}

export function pinMainaCloudExecutionContext(
  session: MainaCloudSession,
): MainaCloudExecutionContext {
  if (!session.scopesVerifiedAt) throw new MainaCloudSessionMismatchError();
  return Object.freeze({
    ownerUserId: session.user.userId,
    accessToken: session.accessToken,
    scopesVerifiedAt: session.scopesVerifiedAt,
  });
}

async function clearMainaCloudSessionIfMatching(
  context: MainaCloudExecutionContext,
): Promise<void> {
  const clearedOwnerUserId = await withSessionMutation(async () => {
    const session = await readStoredSession();
    if (!sessionMatchesExecutionContext(session, context)) return null;
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return context.ownerUserId;
  });
  await clearOwnerMemoryCache(clearedOwnerUserId);
}

export async function mainaCloudRequestJson(
  path: string,
  init: RequestInit = {},
  options?: {
    acceptHttpErrors?: boolean;
    executionContext?: MainaCloudExecutionContext;
  },
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
  if (options?.executionContext
    && !sessionMatchesExecutionContext(session, options.executionContext)) {
    throw new MainaCloudSessionMismatchError();
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
    if (response.status === 401) {
      // Preserve nothing but an opaque expired token; no local meeting state
      // is mutated here. The caller maps this to an auth-blocked cloud job.
      if (options?.executionContext) {
        await clearMainaCloudSessionIfMatching(options.executionContext);
      } else {
        await clearMainaCloudSession();
      }
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
    scopes: [],
    scopesVerifiedAt: null,
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
      user?: { user_id?: unknown; email?: unknown; display_name?: unknown; role?: unknown; scopes?: unknown };
    };
    if (typeof body.user?.user_id === 'string' && typeof body.user.email === 'string') {
      const scopes = Array.isArray(body.user.scopes)
        ? body.user.scopes.filter((scope): scope is string => typeof scope === 'string')
        : null;
      const refreshed: MainaCloudSession = {
        ...session,
        expiresAt: typeof body.expires_at === 'string' ? body.expires_at : session.expiresAt,
        scopes: scopes ?? [],
        scopesVerifiedAt: scopes ? Date.now() : null,
        user: {
          userId: body.user.user_id,
          email: body.user.email,
          displayName: typeof body.user.display_name === 'string' ? body.user.display_name : null,
          role: typeof body.user.role === 'string' ? body.user.role : null,
        },
      };
      return withSessionMutation(async () => {
        const current = await readStoredSession();
        if (!sameSessionCredential(current, session)) return current;
        await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(refreshed));
        return refreshed;
      });
    }
    return session;
  } catch (cause) {
    if (cause instanceof MainaCloudApiError && cause.status === 401) return null;
    // A temporary offline state must not log the user out or block local work.
    return session;
  }
}

export function mainaCloudSessionHasScope(session: MainaCloudSession, scope: string): boolean {
  return session.scopes.includes('*') || session.scopes.includes(scope);
}

export async function requireMainaCloudScope(
  scope: string,
  executionContext?: MainaCloudExecutionContext,
): Promise<MainaCloudSession> {
  const stored = await getMainaCloudSession();
  if (!stored) {
    throw new MainaCloudScopeError('cloud_scope_unverified', 'Connect Maina Cloud to use Memory.');
  }
  if (executionContext) {
    if (!sessionMatchesExecutionContext(stored, executionContext)) {
      throw new MainaCloudSessionMismatchError();
    }
    if (!stored.scopesVerifiedAt || !mainaCloudSessionHasScope(stored, scope)) {
      throw new MainaCloudScopeError(
        'cloud_scope_repair_required',
        'Re-pair this phone in Settings to enable Memory. Your local meetings are safe.',
      );
    }
    return stored;
  }
  if (stored.scopesVerifiedAt && mainaCloudSessionHasScope(stored, scope)) return stored;

  const refreshed = await getMainaCloudConnection();
  if (!refreshed) {
    throw new MainaCloudScopeError('cloud_scope_unverified', 'Connect Maina Cloud to use Memory.');
  }
  if (!refreshed.scopesVerifiedAt) {
    throw new MainaCloudScopeError(
      'cloud_scope_unverified',
      'Maina could not verify Cloud access. Check your internet and refresh.',
    );
  }
  if (!mainaCloudSessionHasScope(refreshed, scope)) {
    throw new MainaCloudScopeError(
      'cloud_scope_repair_required',
      'Re-pair this phone in Settings to enable Memory. Your local meetings are safe.',
    );
  }
  return refreshed;
}

export function shouldClearMainaCloudSession(cause: unknown): boolean {
  return cause instanceof MainaCloudApiError && cause.status === 401;
}
