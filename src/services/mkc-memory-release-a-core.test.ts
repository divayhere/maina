import { describe, expect, it } from 'vitest';

import {
  meetingDetailFixture,
  meetingLibraryFixture,
  meetingTranscriptFixture,
  releaseATranscriptSha256,
} from './__fixtures__/mkc-release-a-fixtures';
import {
  buildMeetingDetailPath,
  buildMeetingLibraryPath,
  buildMeetingTranscriptPath,
  decodeMeetingDetailResponse,
  decodeMeetingLibraryResponse,
  decodeMeetingTranscriptPage,
  MKC_RELEASE_A_CONTRACT,
  MkcReleaseAContractError,
} from './mkc-memory-release-a-core';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('MKC Release A Meetings boundary', () => {
  it('is pinned to the qualified backend commit and leaves incomplete frozen schemas blocked', () => {
    expect(MKC_RELEASE_A_CONTRACT).toEqual({
      backendCommit: '8d58470',
      meetings: 'contract-complete-default-off',
      frozenOpen: 'blocked-openapi-generic-response',
      frozenChapter: 'blocked-openapi-generic-response',
      frozenSource: 'blocked-until-frozen-open-boundary-complete',
    });
  });

  it('builds deterministic encoded list, detail and transcript paths without credentials', () => {
    expect(buildMeetingLibraryPath({
      query: ' cobalt launch ',
      occurredFrom: '2026-08-01T00:00:00.000Z',
      readiness: 'ready',
      sort: 'oldest',
      pageSize: 25,
      cursor: 'opaque+/=',
    })).toBe('/v1/meetings?q=cobalt+launch&occurred_from=2026-08-01T00%3A00%3A00.000Z&readiness=ready&sort=oldest&page_size=25&cursor=opaque%2B%2F%3D');
    expect(buildMeetingDetailPath('meeting:maina:id/with space'))
      .toBe('/v1/meetings/meeting%3Amaina%3Aid%2Fwith%20space');
    expect(buildMeetingTranscriptPath({ sourceKey: 'meeting:maina:id', pageSize: 100, cursor: 'next' }))
      .toBe('/v1/meetings/meeting%3Amaina%3Aid/transcript?page_size=100&cursor=next');
    expect(() => buildMeetingLibraryPath({ pageSize: 101 })).toThrow(MkcReleaseAContractError);
  });

  it('decodes strict library, detail and transcript fixtures', () => {
    expect(decodeMeetingLibraryResponse(meetingLibraryFixture)).toEqual(meetingLibraryFixture);
    expect(decodeMeetingDetailResponse(meetingDetailFixture, meetingDetailFixture.source_key)).toEqual(meetingDetailFixture);
    expect(decodeMeetingTranscriptPage(meetingTranscriptFixture, {
      sourceKey: meetingTranscriptFixture.source_key,
      transcriptSha256: releaseATranscriptSha256,
    })).toEqual(meetingTranscriptFixture);
  });

  it('fails closed on an unknown library field or wrong schema version', () => {
    expect(() => decodeMeetingLibraryResponse({ ...meetingLibraryFixture, unexpected: true }))
      .toThrow(MkcReleaseAContractError);
    expect(() => decodeMeetingLibraryResponse({ ...meetingLibraryFixture, schema_version: 'mkc.meeting-library.v2' }))
      .toThrow(MkcReleaseAContractError);
  });

  it('fails closed when a meeting is not proven as Maina app provenance', () => {
    const detail = clone(meetingDetailFixture) as unknown as Record<string, unknown>;
    detail.provenance = { ...meetingDetailFixture.provenance, kind: 'manual' };
    expect(() => decodeMeetingDetailResponse(detail)).toThrow(MkcReleaseAContractError);
  });

  it('fails closed on source substitution or unsafe continuation URL', () => {
    expect(() => decodeMeetingDetailResponse(meetingDetailFixture, 'meeting:maina:other'))
      .toThrow(MkcReleaseAContractError);
    const detail = clone(meetingDetailFixture);
    detail.transcript.continuation.url = 'https://foreign.example/transcript';
    expect(() => decodeMeetingDetailResponse(detail)).toThrow(MkcReleaseAContractError);
  });

  it('fails closed when transcript continuation crosses source or checksum identity', () => {
    expect(() => decodeMeetingTranscriptPage(meetingTranscriptFixture, { sourceKey: 'meeting:maina:other' }))
      .toThrow(MkcReleaseAContractError);
    expect(() => decodeMeetingTranscriptPage(meetingTranscriptFixture, {
      sourceKey: meetingTranscriptFixture.source_key,
      transcriptSha256: 'b'.repeat(64),
    })).toThrowError('The effective transcript changed while it was being read.');
  });

  it('rejects malformed checksums, dates and negative counters', () => {
    expect(() => decodeMeetingTranscriptPage({ ...meetingTranscriptFixture, transcript_sha256: 'short' }, {
      sourceKey: meetingTranscriptFixture.source_key,
    })).toThrow(MkcReleaseAContractError);
    expect(() => decodeMeetingLibraryResponse({ ...meetingLibraryFixture, total: -1 }))
      .toThrow(MkcReleaseAContractError);
    expect(() => decodeMeetingLibraryResponse({
      ...meetingLibraryFixture,
      meetings: [{ ...meetingLibraryFixture.meetings[0], occurred_at: 'not-a-date' }],
    })).toThrow(MkcReleaseAContractError);
  });
});
