/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  memoryPulseFixture,
  smartRecallDefinitionFixture,
  smartRecallListFixture,
  smartRecallRunFixture,
} from './__fixtures__/mkc-memory-releases-fixtures';

const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  request: vi.fn(),
  getCache: vi.fn(),
  putCache: vi.fn(),
}));

vi.mock('./mainaCloudSession', () => {
  class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  }
  class MainaCloudScopeError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return {
    MainaCloudApiError,
    MainaCloudScopeError,
    requireMainaCloudScope: mocks.requireScope,
    mainaCloudRequestJson: mocks.request,
  };
});

vi.mock('./mkc-memory-cache', () => ({
  getMkcMemoryCacheEntry: mocks.getCache,
  putMkcMemoryCacheEntry: mocks.putCache,
}));

import { MainaCloudApiError, MainaCloudScopeError } from './mainaCloudSession';
import { MkcMemoryReadError } from './mkc-memory-client';
import {
  getMemoryPulse,
  getSavedSmartRecall,
  listSavedSmartRecalls,
  markMemoryPulseViewed,
  prepareSavedSmartRecall,
  runSavedSmartRecall,
} from './mkc-memory-releases';

describe('MKC Memory Pulse and saved Recall client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireScope.mockResolvedValue({
      scopes: ['recall:read'], scopesVerifiedAt: 1,
      user: { userId: 'owner-a', email: 'owner@example.test' },
    });
  });

  it('stays default-off before session, cache, or network work', async () => {
    await expect(getMemoryPulse({ enabled: false })).rejects.toEqual(expect.objectContaining({ kind: 'invalid' }));
    await expect(listSavedSmartRecalls({ enabled: false })).rejects.toEqual(expect.objectContaining({ kind: 'invalid' }));
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('requires auth/me recall scope and reports legacy re-pair without clearing cache', async () => {
    mocks.requireScope.mockRejectedValue(new MainaCloudScopeError(
      'cloud_scope_repair_required',
      'Re-pair this phone in Settings to enable Memory.',
    ));
    await expect(getMemoryPulse({ enabled: true })).rejects.toEqual(expect.objectContaining({
      kind: 'auth', message: expect.stringContaining('Re-pair'),
    } satisfies Partial<MkcMemoryReadError>));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.getCache).not.toHaveBeenCalled();
  });

  it('strictly reads and owner-scopes Pulse, then records one explicit viewed watermark', async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, ok: true, data: memoryPulseFixture })
      .mockResolvedValueOnce({ status: 200, ok: true, data: { viewed_at: memoryPulseFixture.observed_at } });
    await expect(getMemoryPulse({ enabled: true, timezone: 'Asia/Kolkata' })).resolves.toEqual(expect.objectContaining({
      data: memoryPulseFixture, source: 'network',
    }));
    expect(mocks.request).toHaveBeenNthCalledWith(1, '/v1/memory-pulse?timezone=Asia%2FKolkata', expect.objectContaining({ method: 'GET' }));
    expect(mocks.putCache).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: 'owner-a', kind: 'pulse' }));
    await expect(markMemoryPulseViewed({ observedAt: memoryPulseFixture.observed_at, enabled: true })).resolves.toEqual({
      viewed_at: memoryPulseFixture.observed_at,
    });
    expect(mocks.request).toHaveBeenNthCalledWith(2, '/v1/memory-pulse/viewed', expect.objectContaining({ method: 'POST' }));
  });

  it('uses only the same owner cache for an offline read and labels it as cached', async () => {
    mocks.request.mockRejectedValue(new MainaCloudApiError('offline', 0, 'network_error'));
    mocks.getCache.mockResolvedValue({ payload: smartRecallListFixture, fetchedAt: 123, expiresAt: null });
    await expect(listSavedSmartRecalls({ enabled: true })).resolves.toEqual({
      data: smartRecallListFixture, source: 'cache', fetchedAt: 123,
    });
    expect(mocks.getCache).toHaveBeenCalledWith('owner-a', expect.stringContaining('owner-a'));
  });

  it('binds saved Recall detail/run/prepare to one definition and does not invent another identity', async () => {
    mocks.request
      .mockResolvedValueOnce({ status: 200, ok: true, data: smartRecallDefinitionFixture })
      .mockResolvedValueOnce({ status: 201, ok: true, data: smartRecallRunFixture })
      .mockResolvedValueOnce({ status: 201, ok: true, data: smartRecallRunFixture });
    await expect(getSavedSmartRecall({ definitionId: 'smart-recall-1', enabled: true })).resolves.toEqual(expect.objectContaining({ data: smartRecallDefinitionFixture }));
    await expect(runSavedSmartRecall({ definitionId: 'smart-recall-1', timezone: 'UTC', enabled: true })).resolves.toEqual(smartRecallRunFixture);
    await expect(prepareSavedSmartRecall({ definitionId: 'smart-recall-1', timezone: 'UTC', enabled: true })).resolves.toEqual(smartRecallRunFixture);
    expect(mocks.request).toHaveBeenNthCalledWith(2, '/v1/smart-recalls/smart-recall-1/run', expect.objectContaining({ method: 'POST', body: JSON.stringify({ timezone: 'UTC' }) }));
    expect(mocks.request).toHaveBeenNthCalledWith(3, '/v1/smart-recalls/smart-recall-1/prepare', expect.objectContaining({ method: 'POST', body: JSON.stringify({ timezone: 'UTC' }) }));
  });

  it('fails closed on a foreign or checksum-drifted run and never falls back to cache', async () => {
    mocks.request.mockResolvedValue({
      status: 201, ok: true,
      data: { ...smartRecallRunFixture, smart_recall: { ...smartRecallRunFixture.smart_recall, id: 'foreign' } },
    });
    await expect(runSavedSmartRecall({ definitionId: 'smart-recall-1', enabled: true })).rejects.toEqual(expect.objectContaining({ kind: 'integrity', retryable: false }));
    expect(mocks.getCache).not.toHaveBeenCalled();
  });
});
