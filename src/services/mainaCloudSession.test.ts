/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
const mocks = vi.hoisted(() => ({ clearMkcMemoryCacheForOwner: vi.fn(async () => {}) }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { store.delete(key); }),
}));

vi.mock('@/data/settings', () => ({ deleteSetting: vi.fn(async () => {}) }));
vi.mock('@/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/services/mkc-memory-cache', () => ({ clearMkcMemoryCacheForOwner: mocks.clearMkcMemoryCacheForOwner }));

import {
  MainaCloudApiError,
  clearMainaCloudSession,
  createMainaCloudPairing,
  exchangeMainaCloudPairing,
  formatMainaCloudPairingCode,
  getMainaCloudSession,
  mainaCloudFetch,
  saveMainaCloudSession,
} from './mainaCloudSession';

const validSession = {
  accessToken: 'opaque-scoped-token',
  expiresAt: '2030-01-01T00:00:00.000Z',
  user: { userId: 'user-1', email: 'owner@maina.local', displayName: 'Divay', role: 'owner' },
};

describe('mainaCloudSession', () => {
  beforeEach(async () => {
    store.clear();
    vi.restoreAllMocks();
    mocks.clearMkcMemoryCacheForOwner.mockClear();
    await clearMainaCloudSession();
  });

  it('stores only the scoped device session in SecureStore', async () => {
    await saveMainaCloudSession(validSession);
    expect(await getMainaCloudSession()).toEqual(validSession);
    expect([...store.values()].join('')).not.toContain('provider');
  });

  it('clears only the signed-in owner cloud cache while preserving local meeting storage', async () => {
    await saveMainaCloudSession(validSession);
    await clearMainaCloudSession();
    expect(mocks.clearMkcMemoryCacheForOwner).toHaveBeenCalledWith('user-1');
    expect(mocks.clearMkcMemoryCacheForOwner).toHaveBeenCalledTimes(1);
  });

  it('displays the case-sensitive pairing credential byte-for-byte', () => {
    const code = 'mp_aB9z_Xy-17Q';
    expect(formatMainaCloudPairingCode(code)).toBe(code);
  });

  it('accepts the deployed pairing exchange user.id contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'scoped-mobile-session',
      expires_at: '2030-01-01T00:00:00.000Z',
      user: { id: 'user-production-shape', email: 'owner@maina.local', display_name: 'Divay', role: 'owner' },
    }), { status: 200 })));

    const session = await exchangeMainaCloudPairing({
      pairingId: 'mobile_pairing_test',
      verificationCode: 'mp_aB9z_Xy-17Q',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(session.user.userId).toBe('user-production-shape');
    expect(await getMainaCloudSession()).toEqual(session);
  });

  it('uses a platform-neutral fallback label for either mobile client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pairing_id: 'pairing-1',
      verification_code: 'mp_case-sensitive',
      expires_at: '2030-01-01T00:00:00.000Z',
    }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createMainaCloudPairing('');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      device_label: 'Maina mobile',
    });
  });

  it('never exposes a transport hostname during pairing or exchange', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new TypeError('Failed to fetch https://private-backend.example'),
    ));

    await expect(createMainaCloudPairing('iPhone')).rejects.toEqual(expect.objectContaining({
      name: 'MainaCloudApiError',
      status: 0,
      failureClass: 'transport_unknown',
      message: 'Waiting for internet. Maina will continue automatically.',
    } satisfies Partial<MainaCloudApiError>));
    await expect(exchangeMainaCloudPairing({
      pairingId: 'pairing-1',
      verificationCode: 'mp_secret',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })).rejects.toEqual(expect.not.objectContaining({
      message: expect.stringContaining('private-backend.example'),
    }));
  });

  it('removes an expired session before any cloud call', async () => {
    await saveMainaCloudSession({ ...validSession, expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(await getMainaCloudSession()).toBeNull();
  });

  it('turns an unauthorized server reply into a typed auth error and clears the phone session', async () => {
    await saveMainaCloudSession(validSession);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'auth_invalid', message: 'expired' } }), { status: 401 })));
    await expect(mainaCloudFetch('/v1/auth/me')).rejects.toEqual(expect.objectContaining({
      name: 'MainaCloudApiError', status: 401, code: 'auth_invalid', failureClass: 'auth',
      message: 'Reconnect Maina Cloud. Your recording and transcript are safe.',
    } satisfies Partial<MainaCloudApiError>));
    expect(await getMainaCloudSession()).toBeNull();
  });
});
