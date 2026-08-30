import type {
  FrozenRecallChapterV1,
  FrozenRecallOpenV1,
  FrozenRecallSourceOpenV1,
  MeetingDetailResponse,
  MeetingLibraryResponse,
  MeetingTranscriptPage,
} from '@/contracts/mkc-release-a.generated';

import { getMkcMemoryCacheEntry, putMkcMemoryCacheEntry } from './mkc-memory-cache';
import { MkcMemoryReadError } from './mkc-memory-client';
import { classifyMkcMemoryFailure, makeMkcMemoryCacheKey, type MkcMemoryResourceKind } from './mkc-memory-core';
import { MKC_MEMORY_FEATURE_FLAGS } from './mkc-memory-flags';
import {
  buildFrozenRecallChapterPath,
  buildFrozenRecallOpenPath,
  buildFrozenRecallSourcePath,
  decodeFrozenRecallChapter,
  decodeFrozenRecallOpen,
  decodeFrozenRecallSource,
} from './mkc-memory-frozen-release-a-core';
import {
  buildMeetingDetailPath,
  buildMeetingLibraryPath,
  buildMeetingTranscriptPath,
  decodeMeetingDetailResponse,
  decodeMeetingLibraryResponse,
  decodeMeetingTranscriptPage,
  MkcReleaseAContractError,
  type MeetingLibraryQuery,
} from './mkc-memory-release-a-core';
import { getMainaCloudSession, MainaCloudApiError, mainaCloudRequestJson } from './mainaCloudSession';

export type MkcMemoryReadResult<T> = {
  data: T;
  source: 'network' | 'cache';
  fetchedAt: number;
};

type ReadInput<T> = {
  enabled?: boolean;
  defaultEnabled: boolean;
  disabledMessage: string;
  path: string;
  kind: MkcMemoryResourceKind;
  scope: unknown;
  decode: (body: unknown) => T;
  checksum?: (data: T) => string | null;
  signal?: AbortSignal;
};

function requireEnabled(input: Pick<ReadInput<unknown>, 'enabled' | 'defaultEnabled' | 'disabledMessage'>): void {
  if (!(input.enabled ?? input.defaultEnabled)) {
    throw new MkcMemoryReadError('invalid', false, input.disabledMessage);
  }
}

function asReadError(cause: unknown): MkcMemoryReadError {
  if (cause instanceof MkcMemoryReadError) return cause;
  if (cause instanceof MkcReleaseAContractError) {
    if (cause.field.endsWith('expires_at')) {
      return new MkcMemoryReadError('expired', false, 'This saved memory is no longer available.');
    }
    return new MkcMemoryReadError('integrity', false, 'Maina could not verify this memory safely.');
  }
  const status = cause instanceof MainaCloudApiError ? cause.status : 0;
  const code = cause instanceof MainaCloudApiError ? cause.code : 'network_error';
  const failure = classifyMkcMemoryFailure({ status, code });
  return new MkcMemoryReadError(failure.kind, failure.retryable, failure.message);
}

async function readReleaseAResource<T>(input: ReadInput<T>): Promise<MkcMemoryReadResult<T>> {
  requireEnabled(input);
  const session = await getMainaCloudSession();
  if (!session) throw new MkcMemoryReadError('auth', false, 'Reconnect Maina Cloud to continue.');
  const cacheKey = makeMkcMemoryCacheKey({
    ownerUserId: session.user.userId,
    kind: input.kind,
    scope: input.scope,
  });
  try {
    const response = await mainaCloudRequestJson(input.path, { method: 'GET', signal: input.signal });
    const data = input.decode(response.data);
    const fetchedAt = Date.now();
    try {
      await putMkcMemoryCacheEntry({
        ownerUserId: session.user.userId,
        cacheKey,
        kind: input.kind,
        payload: data,
        checksum: input.checksum?.(data) ?? null,
        fetchedAt,
      });
    } catch {
      // This cache is rebuildable. A local cache write failure must not turn a
      // verified network response into a failed memory read.
    }
    return { data, source: 'network', fetchedAt };
  } catch (cause) {
    const failure = asReadError(cause);
    if (failure.kind !== 'offline') throw failure;
    let cached: Awaited<ReturnType<typeof getMkcMemoryCacheEntry>>;
    try {
      cached = await getMkcMemoryCacheEntry(session.user.userId, cacheKey);
    } catch (cause) {
      const cachedFailure = asReadError(cause);
      throw cachedFailure.kind === 'expired'
        ? cachedFailure
        : new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
    if (!cached) throw failure;
    try {
      return { data: input.decode(cached.payload), source: 'cache', fetchedAt: cached.fetchedAt };
    } catch (cause) {
      const cachedFailure = asReadError(cause);
      throw cachedFailure.kind === 'expired'
        ? cachedFailure
        : new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
  }
}

export function listCloudMeetings(input: {
  query?: MeetingLibraryQuery;
  enabled?: boolean;
  signal?: AbortSignal;
} = {}): Promise<MkcMemoryReadResult<MeetingLibraryResponse>> {
  const query = input.query ?? {};
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1,
    disabledMessage: 'Cloud Meetings is not enabled in this build.',
    path: buildMeetingLibraryPath(query),
    kind: 'meeting-list',
    scope: query,
    decode: decodeMeetingLibraryResponse,
    signal: input.signal,
  });
}

export function getCloudMeetingDetail(input: {
  sourceKey: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<MkcMemoryReadResult<MeetingDetailResponse>> {
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1,
    disabledMessage: 'Cloud Meetings is not enabled in this build.',
    path: buildMeetingDetailPath(input.sourceKey),
    kind: 'meeting-detail',
    scope: { sourceKey: input.sourceKey },
    decode: (body) => decodeMeetingDetailResponse(body, input.sourceKey),
    checksum: (data) => data.transcript.continuation.transcript_sha256,
    signal: input.signal,
  });
}

export function getCloudMeetingTranscriptPage(input: {
  sourceKey: string;
  transcriptSha256?: string | null;
  pageSize?: number;
  cursor?: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<MkcMemoryReadResult<MeetingTranscriptPage>> {
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1,
    disabledMessage: 'Cloud Meetings is not enabled in this build.',
    path: buildMeetingTranscriptPath(input),
    kind: 'meeting-transcript',
    scope: {
      sourceKey: input.sourceKey,
      transcriptSha256: input.transcriptSha256 ?? null,
      pageSize: input.pageSize ?? null,
      cursor: input.cursor ?? null,
    },
    decode: (body) => decodeMeetingTranscriptPage(body, {
      sourceKey: input.sourceKey,
      transcriptSha256: input.transcriptSha256,
    }),
    checksum: (data) => data.transcript_sha256,
    signal: input.signal,
  });
}

export function openFrozenRecall(input: {
  searchId: string;
  enabled?: boolean;
  signal?: AbortSignal;
  now?: number;
}): Promise<MkcMemoryReadResult<FrozenRecallOpenV1>> {
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileFrozenHandoffV1,
    disabledMessage: 'Saved Recall handoff is not enabled in this build.',
    path: buildFrozenRecallOpenPath(input.searchId),
    kind: 'frozen-recall',
    scope: { searchId: input.searchId, resource: 'open' },
    decode: (body) => decodeFrozenRecallOpen(body, { searchId: input.searchId, now: input.now }),
    checksum: (data) => data.bundle_sha256,
    signal: input.signal,
  });
}

export function getFrozenRecallChapter(input: {
  searchId: string;
  chapterId: string;
  resultSha256: string;
  bundleSha256: string;
  chapterSha256?: string;
  enabled?: boolean;
  signal?: AbortSignal;
  now?: number;
}): Promise<MkcMemoryReadResult<FrozenRecallChapterV1>> {
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileFrozenHandoffV1,
    disabledMessage: 'Saved Recall handoff is not enabled in this build.',
    path: buildFrozenRecallChapterPath(input.searchId, input.chapterId),
    kind: 'frozen-recall',
    scope: {
      searchId: input.searchId,
      chapterId: input.chapterId,
      resultSha256: input.resultSha256,
      bundleSha256: input.bundleSha256,
      chapterSha256: input.chapterSha256 ?? null,
    },
    decode: (body) => decodeFrozenRecallChapter(body, input),
    checksum: (data) => data.chapter_sha256,
    signal: input.signal,
  });
}

export function getFrozenRecallSource(input: {
  searchId: string;
  sourceKey: string;
  resultSha256: string;
  bundleSha256: string;
  enabled?: boolean;
  signal?: AbortSignal;
  now?: number;
}): Promise<MkcMemoryReadResult<FrozenRecallSourceOpenV1>> {
  return readReleaseAResource({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileFrozenHandoffV1,
    disabledMessage: 'Saved Recall handoff is not enabled in this build.',
    path: buildFrozenRecallSourcePath(input.searchId, input.sourceKey),
    kind: 'frozen-recall',
    scope: {
      searchId: input.searchId,
      sourceKey: input.sourceKey,
      resultSha256: input.resultSha256,
      bundleSha256: input.bundleSha256,
    },
    decode: (body) => decodeFrozenRecallSource(body, input),
    checksum: (data) => data.bundle_sha256,
    signal: input.signal,
  });
}
