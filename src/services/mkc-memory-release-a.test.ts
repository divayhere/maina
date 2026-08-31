import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  meetingDetailFixture,
  meetingLibraryFixture,
  meetingTranscriptFixture,
  frozenBundleSha256,
  frozenChapterSha256,
  frozenRecallChapterFixture,
  frozenRecallOpenFixture,
  frozenRecallSourceFixture,
  frozenResultSha256,
  releaseATranscriptSha256,
} from './__fixtures__/mkc-release-a-fixtures';
import { MkcMemoryReadError } from './mkc-memory-client';
import {
  getCloudMeetingDetail,
  getCloudMeetingTranscriptPage,
  getFrozenRecallChapter,
  getFrozenRecallSource,
  listCloudMeetings,
  openFrozenRecall,
} from './mkc-memory-release-a';

const mocks = vi.hoisted(() => ({
  requireScope: vi.fn(),
  fetch: vi.fn(),
  getCache: vi.fn(),
  putCache: vi.fn(),
}));

vi.mock('./mainaCloudSession', () => {
  class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
      this.name = 'MainaCloudApiError';
    }
  }
  return {
    MainaCloudApiError,
    MainaCloudScopeError: class MainaCloudScopeError extends Error {},
    requireMainaCloudScope: mocks.requireScope,
    mainaCloudRequestJson: mocks.fetch,
  };
});

vi.mock('./mkc-memory-cache', () => ({
  getMkcMemoryCacheEntry: mocks.getCache,
  putMkcMemoryCacheEntry: mocks.putCache,
}));

describe('MKC Release A Meetings client', () => {
  beforeEach(() => {
    mocks.requireScope.mockReset();
    mocks.fetch.mockReset();
    mocks.getCache.mockReset();
    mocks.putCache.mockReset();
    mocks.requireScope.mockResolvedValue({
      accessToken: 'redacted-test-token',
      scopes: ['recall:read'],
      scopesVerifiedAt: 1,
      user: { userId: 'owner-a', email: 'owner-a@example.test' },
    });
  });

  it('stays disabled by default and performs no session or network work', async () => {
    await expect(listCloudMeetings({ enabled: false })).rejects.toEqual(
      expect.objectContaining({ kind: 'invalid', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await expect(openFrozenRecall({ searchId: 'search-disabled', enabled: false })).rejects.toEqual(
      expect.objectContaining({ kind: 'invalid', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.requireScope).not.toHaveBeenCalled();
  });

  it('strictly decodes and owner-scopes a successful network result before caching', async () => {
    mocks.fetch.mockResolvedValue({ status: 200, ok: true, data: meetingLibraryFixture });
    await expect(listCloudMeetings({ enabled: true, query: { sort: 'newest' } })).resolves.toEqual({
      data: meetingLibraryFixture,
      source: 'network',
      fetchedAt: expect.any(Number),
    });
    expect(mocks.fetch).toHaveBeenCalledWith('/v1/meetings?sort=newest', expect.objectContaining({ method: 'GET' }));
    expect(mocks.putCache).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'owner-a',
      kind: 'meeting-list',
      payload: meetingLibraryFixture,
    }));
  });

  it('does not fail a verified network read when the rebuildable cache cannot be written', async () => {
    mocks.fetch.mockResolvedValue({ status: 200, ok: true, data: meetingLibraryFixture });
    mocks.putCache.mockRejectedValue(new Error('synthetic cache write failure'));
    await expect(listCloudMeetings({ enabled: true })).resolves.toEqual({
      data: meetingLibraryFixture,
      source: 'network',
      fetchedAt: expect.any(Number),
    });
  });

  it('binds detail and transcript continuation to the requested source and frozen transcript checksum', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ status: 200, ok: true, data: meetingDetailFixture })
      .mockResolvedValueOnce({ status: 200, ok: true, data: meetingTranscriptFixture });
    await expect(getCloudMeetingDetail({
      sourceKey: meetingDetailFixture.source_key,
      enabled: true,
    })).resolves.toEqual(expect.objectContaining({ data: meetingDetailFixture, source: 'network' }));
    await expect(getCloudMeetingTranscriptPage({
      sourceKey: meetingDetailFixture.source_key,
      transcriptSha256: releaseATranscriptSha256,
      pageSize: 25,
      enabled: true,
    })).resolves.toEqual(expect.objectContaining({ data: meetingTranscriptFixture, source: 'network' }));
    expect(mocks.fetch).toHaveBeenNthCalledWith(
      2,
      '/v1/meetings/meeting%3Amaina%3Asynthetic-release-a/transcript?page_size=25',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects a transcript that changed after detail was opened', async () => {
    mocks.fetch.mockResolvedValue({ status: 200, ok: true, data: meetingTranscriptFixture });
    await expect(getCloudMeetingTranscriptPage({
      sourceKey: meetingDetailFixture.source_key,
      transcriptSha256: 'b'.repeat(64),
      enabled: true,
    })).rejects.toEqual(
      expect.objectContaining({ kind: 'integrity', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
  });

  it('uses owner-isolated verified cache only for a network failure', async () => {
    const { MainaCloudApiError } = await import('./mainaCloudSession');
    mocks.fetch.mockRejectedValue(new MainaCloudApiError('offline', 0, 'network_error'));
    mocks.getCache.mockResolvedValue({
      ownerUserId: 'owner-a',
      cacheKey: 'owner-a|meeting-list|{}',
      kind: 'meeting-list',
      payload: meetingLibraryFixture,
      fetchedAt: 123,
    });
    await expect(listCloudMeetings({ enabled: true })).resolves.toEqual({
      data: meetingLibraryFixture,
      source: 'cache',
      fetchedAt: 123,
    });
    expect(mocks.getCache).toHaveBeenCalledWith('owner-a', expect.stringContaining('owner-a'));
  });

  it('does not hide auth or integrity failure behind cached data', async () => {
    const { MainaCloudApiError } = await import('./mainaCloudSession');
    mocks.fetch.mockRejectedValueOnce(new MainaCloudApiError('unauthorized', 401, 'session_expired'));
    await expect(listCloudMeetings({ enabled: true })).rejects.toEqual(
      expect.objectContaining({ kind: 'auth', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.getCache).not.toHaveBeenCalled();

    mocks.fetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      data: { ...meetingLibraryFixture, schema_version: 'wrong' },
    });
    await expect(listCloudMeetings({ enabled: true })).rejects.toEqual(
      expect.objectContaining({ kind: 'integrity', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.getCache).not.toHaveBeenCalled();
  });

  it('fails closed when an offline cache entry is corrupt', async () => {
    const { MainaCloudApiError } = await import('./mainaCloudSession');
    mocks.fetch.mockRejectedValue(new MainaCloudApiError('offline', 0, 'network_error'));
    mocks.getCache.mockRejectedValue(new Error('synthetic corrupt cache'));
    await expect(listCloudMeetings({ enabled: true })).rejects.toEqual(
      expect.objectContaining({ kind: 'integrity', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
  });

  it('opens frozen Recall then binds chapter and source reads to its immutable identity', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ status: 200, ok: true, data: frozenRecallOpenFixture })
      .mockResolvedValueOnce({ status: 200, ok: true, data: frozenRecallChapterFixture })
      .mockResolvedValueOnce({ status: 200, ok: true, data: frozenRecallSourceFixture });
    await expect(openFrozenRecall({
      searchId: frozenRecallOpenFixture.search_id,
      enabled: true,
      now: Date.parse('2026-08-30T00:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({ data: frozenRecallOpenFixture, source: 'network' }));
    await expect(getFrozenRecallChapter({
      searchId: frozenRecallOpenFixture.search_id,
      chapterId: frozenRecallChapterFixture.chapter_id,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      chapterSha256: frozenChapterSha256,
      enabled: true,
      now: Date.parse('2026-08-30T00:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({ data: frozenRecallChapterFixture, source: 'network' }));
    await expect(getFrozenRecallSource({
      searchId: frozenRecallOpenFixture.search_id,
      sourceKey: frozenRecallSourceFixture.source.source_key,
      resultSha256: frozenResultSha256,
      bundleSha256: frozenBundleSha256,
      enabled: true,
      now: Date.parse('2026-08-30T00:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({ data: frozenRecallSourceFixture, source: 'network' }));
  });

  it('does not reveal foreign ownership or fall back to cache after a frozen 404', async () => {
    const { MainaCloudApiError } = await import('./mainaCloudSession');
    mocks.fetch.mockRejectedValue(new MainaCloudApiError('not found', 404, 'recall_frozen_result_not_found'));
    await expect(openFrozenRecall({ searchId: 'search-foreign', enabled: true })).rejects.toEqual(
      expect.objectContaining({ kind: 'expired', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.getCache).not.toHaveBeenCalled();
  });

  it('rechecks expiry when frozen data is served from offline cache', async () => {
    const { MainaCloudApiError } = await import('./mainaCloudSession');
    mocks.fetch.mockRejectedValue(new MainaCloudApiError('offline', 0, 'network_error'));
    mocks.getCache.mockResolvedValue({
      ownerUserId: 'owner-a',
      cacheKey: 'synthetic',
      kind: 'frozen-recall',
      payload: { ...frozenRecallOpenFixture, expires_at: '2026-08-29T00:00:00.000Z' },
      fetchedAt: 123,
    });
    await expect(openFrozenRecall({
      searchId: frozenRecallOpenFixture.search_id,
      enabled: true,
      now: Date.parse('2026-08-30T00:00:00.000Z'),
    })).rejects.toEqual(
      expect.objectContaining({ kind: 'expired', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
  });
});
