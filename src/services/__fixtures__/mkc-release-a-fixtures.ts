import type {
  MeetingDetailResponse,
  MeetingLibraryResponse,
  MeetingTranscriptPage,
} from '@/contracts/mkc-release-a.generated';

export const releaseATranscriptSha256 = 'a'.repeat(64);

export const meetingLibraryFixture: MeetingLibraryResponse = {
  schema_version: 'mkc.meeting-library.v1',
  filters: {
    query: null,
    occurred_from: null,
    occurred_to_exclusive: null,
    readiness: null,
    sort: 'newest',
  },
  total: 1,
  meetings: [{
    source_key: 'meeting:maina:synthetic-release-a',
    title: 'Synthetic release review',
    occurred_at: '2026-08-29T09:00:00.000Z',
    ingested_at: '2026-08-29T09:10:00.000Z',
    readiness: 'ready',
    duration_seconds: 600,
    provenance: { kind: 'maina_app', platform: 'android' },
    summary_preview: 'A synthetic contract fixture with no private meeting content.',
    counts: { decisions: 1, todos: 1, open_questions: 0 },
  }],
  page: { size: 1, has_more: false, next_cursor: null },
};

export const meetingDetailFixture: MeetingDetailResponse = {
  schema_version: 'mkc.meeting-detail.v1',
  source_key: 'meeting:maina:synthetic-release-a',
  title: 'Synthetic release review',
  occurred_at: '2026-08-29T09:00:00.000Z',
  ingested_at: '2026-08-29T09:10:00.000Z',
  readiness: 'ready',
  duration_seconds: 600,
  provenance: {
    kind: 'maina_app',
    platform: 'android',
    captured_at: '2026-08-29T09:00:00.000Z',
    client_schema_version: 'maina.sync.v1',
  },
  workspace: { key: 'maina', name: 'Maina' },
  project: { key: 'captured-meetings', name: 'Captured Meetings' },
  topics: [],
  summary: 'A synthetic contract fixture with no private meeting content.',
  decisions: ['Keep the fixture synthetic.'],
  todos: ['Run the contract tests.'],
  open_questions: [],
  important_points: ['No credentials or customer content are present.'],
  transcript: {
    blocks: [{
      block_key: 'segment-1',
      kind: 'transcript',
      text: 'Synthetic transcript segment.',
      started_at: '2026-08-29T09:00:00.000Z',
      ended_at: '2026-08-29T09:00:15.000Z',
      metadata: {},
    }],
    correction: null,
    continuation: {
      schema_version: 'mkc.meeting-transcript-page.v1',
      total_units: 1,
      transcript_sha256: releaseATranscriptSha256,
      url: '/v1/meetings/meeting%3Amaina%3Asynthetic-release-a/transcript',
    },
  },
  corrections: [],
  current_field_versions: [],
  correction_targets_url: '/v1/sources/meeting%3Amaina%3Asynthetic-release-a/correction-targets',
};

export const meetingTranscriptFixture: MeetingTranscriptPage = {
  schema_version: 'mkc.meeting-transcript-page.v1',
  source_key: 'meeting:maina:synthetic-release-a',
  transcript_sha256: releaseATranscriptSha256,
  correction_key: null,
  total_units: 1,
  units: [{
    block_key: 'segment-1',
    kind: 'transcript',
    text: 'Synthetic transcript segment.',
    started_at: '2026-08-29T09:00:00.000Z',
    ended_at: '2026-08-29T09:00:15.000Z',
  }],
  page: { size: 1, has_more: false, next_cursor: null },
};
