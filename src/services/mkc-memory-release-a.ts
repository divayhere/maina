import type {
  MeetingDetailResponse,
  MeetingLibraryResponse,
  MeetingTranscriptPage,
} from '@/contracts/mkc-release-a.generated';

import { getMkcMemoryCacheEntry, putMkcMemoryCacheEntry } from './mkc-memory-cache';
import { MkcMemoryReadError } from './mkc-memory-client';
import { classifyMkcMemoryFailure, makeMkcMemoryCacheKey, type MkcMemoryResourceKind } from './mkc-memory-core';
import { MKC_MEMORY_FEATURE_FLAGS } from './mkc-memory-flags';
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
import { getMainaCloudSession, MainaCloudApiError, mainaCloudFetch } from './mainaCloudSession';

export type MkcMeetingReadResult<T> = {
  data: T;
  source: 'network' | 'cache';
  fetchedAt: number;
};

type ReadInput<T> = {
  enabled?: boolean;
  path: string;
  kind: MkcMemoryResourceKind;
  scope: unknown;
  decode: (body: unknown) => T;
  checksum?: (data: T) => string | null;
  signal?: AbortSignal;
};

function requireMeetingsEnabled(enabled: boolean | undefined): void {
  if (!(enabled ?? MKC_MEMORY_FEATURE_FLAGS.mobileCloudMeetingsV1)) {
    throw new MkcMemoryReadError('invalid', false, 'Cloud Meetings is not enabled in this build.');
  }
}

function asReadError(cause: unknown): MkcMemoryReadError {
  if (cause instanceof MkcMemoryReadError) return cause;
  if (cause instanceof MkcReleaseAContractError) {
    return new MkcMemoryReadError('integrity', false, 'Maina could not verify this memory safely.');
  }
  const status = cause instanceof MainaCloudApiError ? cause.status : 0;
  const code = cause instanceof MainaCloudApiError ? cause.code : 'network_error';
  const failure = classifyMkcMemoryFailure({ status, code });
  return new MkcMemoryReadError(failure.kind, failure.retryable, failure.message);
}

async function readMeetingResource<T>(input: ReadInput<T>): Promise<MkcMeetingReadResult<T>> {
  requireMeetingsEnabled(input.enabled);
  const session = await getMainaCloudSession();
  if (!session) throw new MkcMemoryReadError('auth', false, 'Reconnect Maina Cloud to continue.');
  const cacheKey = makeMkcMemoryCacheKey({
    ownerUserId: session.user.userId,
    kind: input.kind,
    scope: input.scope,
  });
  try {
    const response = await mainaCloudFetch(input.path, { method: 'GET', signal: input.signal });
    const data = input.decode(await response.json());
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
      // verified network response into a failed Meetings read.
    }
    return { data, source: 'network', fetchedAt };
  } catch (cause) {
    const failure = asReadError(cause);
    if (failure.kind !== 'offline') throw failure;
    let cached: Awaited<ReturnType<typeof getMkcMemoryCacheEntry>>;
    try {
      cached = await getMkcMemoryCacheEntry(session.user.userId, cacheKey);
    } catch {
      throw new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
    if (!cached) throw failure;
    try {
      return { data: input.decode(cached.payload), source: 'cache', fetchedAt: cached.fetchedAt };
    } catch {
      throw new MkcMemoryReadError('integrity', false, 'Maina could not verify this saved memory safely.');
    }
  }
}

export function listCloudMeetings(input: {
  query?: MeetingLibraryQuery;
  enabled?: boolean;
  signal?: AbortSignal;
} = {}): Promise<MkcMeetingReadResult<MeetingLibraryResponse>> {
  const query = input.query ?? {};
  return readMeetingResource({
    enabled: input.enabled,
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
}): Promise<MkcMeetingReadResult<MeetingDetailResponse>> {
  return readMeetingResource({
    enabled: input.enabled,
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
}): Promise<MkcMeetingReadResult<MeetingTranscriptPage>> {
  return readMeetingResource({
    enabled: input.enabled,
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
