/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { store.delete(key); }),
}));

vi.mock('@/data/settings', () => ({ deleteSetting: vi.fn(async () => {}) }));
vi.mock('@/services/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  MainaCloudApiError,
  clearMainaCloudSession,
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
    await clearMainaCloudSession();
  });

  it('stores only the scoped device session in SecureStore', async () => {
    await saveMainaCloudSession(validSession);
    expect(await getMainaCloudSession()).toEqual(validSession);
    expect([...store.values()].join('')).not.toContain('provider');
  });

  it('displays the case-sensitive pairing credential byte-for-byte', () => {
    const code = 'mp_aB9z_Xy-17Q';
    expect(formatMainaCloudPairingCode(code)).toBe(code);
  });

  it('removes an expired session before any cloud call', async () => {
    await saveMainaCloudSession({ ...validSession, expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(await getMainaCloudSession()).toBeNull();
  });

  it('turns an unauthorized server reply into a typed auth error and clears the phone session', async () => {
    await saveMainaCloudSession(validSession);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'auth_invalid', message: 'expired' } }), { status: 401 })));
    await expect(mainaCloudFetch('/v1/auth/me')).rejects.toEqual(expect.objectContaining({
      name: 'MainaCloudApiError', status: 401, code: 'auth_invalid', message: 'expired',
    } satisfies Partial<MainaCloudApiError>));
    expect(await getMainaCloudSession()).toBeNull();
  });
});
