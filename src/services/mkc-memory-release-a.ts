import type {
  FrozenRecallChapterV1,
  FrozenRecallOpenV1,
  FrozenRecallSourceOpenV1,
  MeetingDetailResponse,
  MeetingLibraryResponse,
  MeetingTranscriptPage,
} from '@/contracts/mkc-release-a.generated';

import { MkcMemoryReadError, readCachedMkcMemory, type MkcMemoryReadResult } from './mkc-memory-client';
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
function releaseAContractError(cause: unknown): MkcMemoryReadError | null {
  if (cause instanceof MkcReleaseAContractError) {
    if (cause.field.endsWith('expires_at')) {
      return new MkcMemoryReadError('expired', false, 'This saved memory is no longer available.');
    }
    return new MkcMemoryReadError('integrity', false, 'Maina could not verify this memory safely.');
  }
  return null;
}

export function listCloudMeetings(input: {
  query?: MeetingLibraryQuery;
  enabled?: boolean;
  signal?: AbortSignal;
} = {}): Promise<MkcMemoryReadResult<MeetingLibraryResponse>> {
  const query = input.query ?? {};
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1,
    disabledMessage: 'Cloud Meetings is not enabled in this build.',
    path: buildMeetingLibraryPath(query),
    kind: 'meeting-list',
    scope: query,
    decode: decodeMeetingLibraryResponse,
    mapContractError: releaseAContractError,
    signal: input.signal,
  });
}

export function getCloudMeetingDetail(input: {
  sourceKey: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<MkcMemoryReadResult<MeetingDetailResponse>> {
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1,
    disabledMessage: 'Cloud Meetings is not enabled in this build.',
    path: buildMeetingDetailPath(input.sourceKey),
    kind: 'meeting-detail',
    scope: { sourceKey: input.sourceKey },
    decode: (body) => decodeMeetingDetailResponse(body, input.sourceKey),
    checksum: (data) => data.transcript.continuation.transcript_sha256,
    mapContractError: releaseAContractError,
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
  return readCachedMkcMemory({
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
    mapContractError: releaseAContractError,
    signal: input.signal,
  });
}

export function openFrozenRecall(input: {
  searchId: string;
  enabled?: boolean;
  signal?: AbortSignal;
  now?: number;
}): Promise<MkcMemoryReadResult<FrozenRecallOpenV1>> {
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileFrozenHandoffV1,
    disabledMessage: 'Saved Recall handoff is not enabled in this build.',
    path: buildFrozenRecallOpenPath(input.searchId),
    kind: 'frozen-recall',
    scope: { searchId: input.searchId, resource: 'open' },
    decode: (body) => decodeFrozenRecallOpen(body, { searchId: input.searchId, now: input.now }),
    checksum: (data) => data.bundle_sha256,
    expiresAt: (data) => Date.parse(data.expires_at),
    mapContractError: releaseAContractError,
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
  return readCachedMkcMemory({
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
    expiresAt: (data) => Date.parse(data.expires_at),
    mapContractError: releaseAContractError,
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
  return readCachedMkcMemory({
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
    expiresAt: (data) => Date.parse(data.expires_at),
    mapContractError: releaseAContractError,
    signal: input.signal,
  });
}
