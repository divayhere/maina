import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  meetingDetailFixture,
  meetingLibraryFixture,
  meetingTranscriptFixture,
  releaseATranscriptSha256,
} from './__fixtures__/mkc-release-a-fixtures';
import { MkcMemoryReadError } from './mkc-memory-client';
import { getCloudMeetingDetail, getCloudMeetingTranscriptPage, listCloudMeetings } from './mkc-memory-release-a';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
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
    getMainaCloudSession: mocks.getSession,
    mainaCloudFetch: mocks.fetch,
  };
});

vi.mock('./mkc-memory-cache', () => ({
  getMkcMemoryCacheEntry: mocks.getCache,
  putMkcMemoryCacheEntry: mocks.putCache,
}));

describe('MKC Release A Meetings client', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.fetch.mockReset();
    mocks.getCache.mockReset();
    mocks.putCache.mockReset();
    mocks.getSession.mockResolvedValue({
      accessToken: 'redacted-test-token',
      user: { userId: 'owner-a', email: 'owner-a@example.test' },
    });
  });

  it('stays disabled by default and performs no session or network work', async () => {
    await expect(listCloudMeetings({ enabled: false })).rejects.toEqual(
      expect.objectContaining({ kind: 'invalid', retryable: false } satisfies Partial<MkcMemoryReadError>),
    );
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('strictly decodes and owner-scopes a successful network result before caching', async () => {
    mocks.fetch.mockResolvedValue({ json: async () => meetingLibraryFixture });
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
    mocks.fetch.mockResolvedValue({ json: async () => meetingLibraryFixture });
    mocks.putCache.mockRejectedValue(new Error('synthetic cache write failure'));
    await expect(listCloudMeetings({ enabled: true })).resolves.toEqual({
      data: meetingLibraryFixture,
      source: 'network',
      fetchedAt: expect.any(Number),
    });
  });

  it('binds detail and transcript continuation to the requested source and frozen transcript checksum', async () => {
    mocks.fetch
      .mockResolvedValueOnce({ json: async () => meetingDetailFixture })
      .mockResolvedValueOnce({ json: async () => meetingTranscriptFixture });
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
    mocks.fetch.mockResolvedValue({ json: async () => meetingTranscriptFixture });
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

    mocks.fetch.mockResolvedValueOnce({ json: async () => ({ ...meetingLibraryFixture, schema_version: 'wrong' }) });
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
});
