import type {
  MeetingDetailResponse,
  MeetingLibraryItem,
  MeetingLibraryResponse,
  MeetingReadiness,
  MeetingTranscriptPage,
  MeetingTranscriptUnit,
} from '@/contracts/mkc-release-a.generated';

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export const MKC_RELEASE_A_CONTRACT = {
  backendCommit: '57cbb52',
  meetings: 'contract-complete-default-off',
  frozenOpen: 'contract-complete-default-off-deployment-pending',
  frozenChapter: 'contract-complete-default-off-deployment-pending',
  frozenSource: 'contract-complete-default-off-deployment-pending',
} as const;

export class MkcReleaseAContractError extends Error {
  constructor(readonly field: string, message = `Invalid MKC Release A response at ${field}.`) {
    super(message);
    this.name = 'MkcReleaseAContractError';
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MkcReleaseAContractError(field);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: readonly string[], field: string): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) throw new MkcReleaseAContractError(field);
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new MkcReleaseAContractError(field);
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  const result = string(value, field);
  if (!result.trim()) throw new MkcReleaseAContractError(field);
  return result;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function isoDate(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new MkcReleaseAContractError(field);
  return result;
}

function nullableIsoDate(value: unknown, field: string): string | null {
  return value === null ? null : isoDate(value, field);
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new MkcReleaseAContractError(field);
  return Number(value);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new MkcReleaseAContractError(field);
  return value;
}

function checksum(value: unknown, field: string): string {
  const result = string(value, field);
  if (!CHECKSUM_PATTERN.test(result)) throw new MkcReleaseAContractError(field);
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new MkcReleaseAContractError(field);
  return value.map((item, index) => string(item, `${field}[${index}]`));
}

function recordArray(value: unknown, field: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new MkcReleaseAContractError(field);
  return value.map((item, index) => record(item, `${field}[${index}]`));
}

function readiness(value: unknown, field: string): MeetingReadiness {
  if (value !== 'ready' && value !== 'transcript_only' && value !== 'processing' && value !== 'summary_failed') {
    throw new MkcReleaseAContractError(field);
  }
  return value;
}

function nullableDuration(value: unknown, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function page(value: unknown, field: string) {
  const item = record(value, field);
  exactKeys(item, ['size', 'has_more', 'next_cursor'], field);
  return {
    size: integer(item.size, `${field}.size`),
    has_more: boolean(item.has_more, `${field}.has_more`),
    next_cursor: nullableString(item.next_cursor, `${field}.next_cursor`),
  };
}

function transcriptUnit(value: unknown, field: string, allowMetadata = false): MeetingTranscriptUnit & { metadata?: JsonRecord } {
  const item = record(value, field);
  exactKeys(item, allowMetadata
    ? ['block_key', 'kind', 'text', 'started_at', 'ended_at', 'metadata']
    : ['block_key', 'kind', 'text', 'started_at', 'ended_at'], field);
  const result: MeetingTranscriptUnit & { metadata?: JsonRecord } = {
    block_key: nonEmptyString(item.block_key, `${field}.block_key`),
    kind: nonEmptyString(item.kind, `${field}.kind`),
    text: string(item.text, `${field}.text`),
    started_at: nullableIsoDate(item.started_at, `${field}.started_at`),
    ended_at: nullableIsoDate(item.ended_at, `${field}.ended_at`),
  };
  if (allowMetadata && item.metadata !== undefined) result.metadata = record(item.metadata, `${field}.metadata`);
  return result;
}

function meetingItem(value: unknown, field: string): MeetingLibraryItem {
  const item = record(value, field);
  exactKeys(item, [
    'source_key', 'title', 'occurred_at', 'ingested_at', 'readiness', 'duration_seconds',
    'provenance', 'summary_preview', 'counts',
  ], field);
  const provenance = record(item.provenance, `${field}.provenance`);
  exactKeys(provenance, ['kind', 'platform'], `${field}.provenance`);
  if (provenance.kind !== 'maina_app') throw new MkcReleaseAContractError(`${field}.provenance.kind`);
  if (provenance.platform !== null && provenance.platform !== 'android' && provenance.platform !== 'ios') {
    throw new MkcReleaseAContractError(`${field}.provenance.platform`);
  }
  const counts = record(item.counts, `${field}.counts`);
  exactKeys(counts, ['decisions', 'todos', 'open_questions'], `${field}.counts`);
  return {
    source_key: nonEmptyString(item.source_key, `${field}.source_key`),
    title: string(item.title, `${field}.title`),
    occurred_at: isoDate(item.occurred_at, `${field}.occurred_at`),
    ingested_at: isoDate(item.ingested_at, `${field}.ingested_at`),
    readiness: readiness(item.readiness, `${field}.readiness`),
    duration_seconds: nullableDuration(item.duration_seconds, `${field}.duration_seconds`),
    provenance: { kind: 'maina_app', platform: provenance.platform },
    summary_preview: nullableString(item.summary_preview, `${field}.summary_preview`),
    counts: {
      decisions: integer(counts.decisions, `${field}.counts.decisions`),
      todos: integer(counts.todos, `${field}.counts.todos`),
      open_questions: integer(counts.open_questions, `${field}.counts.open_questions`),
    },
  };
}

export function decodeMeetingLibraryResponse(value: unknown): MeetingLibraryResponse {
  const body = record(value, 'meeting-library');
  exactKeys(body, ['schema_version', 'filters', 'total', 'meetings', 'page'], 'meeting-library');
  if (body.schema_version !== 'mkc.meeting-library.v1') throw new MkcReleaseAContractError('meeting-library.schema_version');
  const filters = record(body.filters, 'meeting-library.filters');
  exactKeys(filters, ['query', 'occurred_from', 'occurred_to_exclusive', 'readiness', 'sort'], 'meeting-library.filters');
  if (filters.sort !== 'newest' && filters.sort !== 'oldest') throw new MkcReleaseAContractError('meeting-library.filters.sort');
  if (!Array.isArray(body.meetings)) throw new MkcReleaseAContractError('meeting-library.meetings');
  return {
    schema_version: 'mkc.meeting-library.v1',
    filters: {
      query: nullableString(filters.query, 'meeting-library.filters.query'),
      occurred_from: filters.occurred_from === null ? null : isoDate(filters.occurred_from, 'meeting-library.filters.occurred_from'),
      occurred_to_exclusive: filters.occurred_to_exclusive === null ? null : isoDate(filters.occurred_to_exclusive, 'meeting-library.filters.occurred_to_exclusive'),
      readiness: nullableString(filters.readiness, 'meeting-library.filters.readiness'),
      sort: filters.sort,
    },
    total: integer(body.total, 'meeting-library.total'),
    meetings: body.meetings.map((item, index) => meetingItem(item, `meeting-library.meetings[${index}]`)),
    page: page(body.page, 'meeting-library.page'),
  };
}

export function decodeMeetingTranscriptPage(value: unknown, expected: {
  sourceKey: string;
  transcriptSha256?: string | null;
}): MeetingTranscriptPage {
  const body = record(value, 'meeting-transcript');
  exactKeys(body, ['schema_version', 'source_key', 'transcript_sha256', 'correction_key', 'total_units', 'units', 'page'], 'meeting-transcript');
  if (body.schema_version !== 'mkc.meeting-transcript-page.v1') throw new MkcReleaseAContractError('meeting-transcript.schema_version');
  const sourceKey = nonEmptyString(body.source_key, 'meeting-transcript.source_key');
  if (sourceKey !== expected.sourceKey) throw new MkcReleaseAContractError('meeting-transcript.source_key');
  const transcriptSha256 = checksum(body.transcript_sha256, 'meeting-transcript.transcript_sha256');
  if (expected.transcriptSha256 && transcriptSha256 !== expected.transcriptSha256) {
    throw new MkcReleaseAContractError('meeting-transcript.transcript_sha256', 'The effective transcript changed while it was being read.');
  }
  if (!Array.isArray(body.units)) throw new MkcReleaseAContractError('meeting-transcript.units');
  return {
    schema_version: 'mkc.meeting-transcript-page.v1',
    source_key: sourceKey,
    transcript_sha256: transcriptSha256,
    correction_key: nullableString(body.correction_key, 'meeting-transcript.correction_key'),
    total_units: integer(body.total_units, 'meeting-transcript.total_units'),
    units: body.units.map((item, index) => transcriptUnit(item, `meeting-transcript.units[${index}]`)),
    page: page(body.page, 'meeting-transcript.page'),
  };
}

export function decodeMeetingDetailResponse(value: unknown, expectedSourceKey?: string): MeetingDetailResponse {
  const body = record(value, 'meeting-detail');
  exactKeys(body, [
    'schema_version', 'source_key', 'title', 'occurred_at', 'ingested_at', 'readiness', 'duration_seconds',
    'provenance', 'workspace', 'project', 'topics', 'summary', 'decisions', 'todos', 'open_questions',
    'important_points', 'transcript', 'corrections', 'current_field_versions', 'correction_targets_url',
  ], 'meeting-detail');
  if (body.schema_version !== 'mkc.meeting-detail.v1') throw new MkcReleaseAContractError('meeting-detail.schema_version');
  const sourceKey = nonEmptyString(body.source_key, 'meeting-detail.source_key');
  if (expectedSourceKey && sourceKey !== expectedSourceKey) throw new MkcReleaseAContractError('meeting-detail.source_key');
  const provenance = record(body.provenance, 'meeting-detail.provenance');
  exactKeys(provenance, ['kind', 'platform', 'captured_at', 'client_schema_version'], 'meeting-detail.provenance');
  if (provenance.kind !== 'maina_app') throw new MkcReleaseAContractError('meeting-detail.provenance.kind');
  if (provenance.platform !== null && provenance.platform !== 'android' && provenance.platform !== 'ios') {
    throw new MkcReleaseAContractError('meeting-detail.provenance.platform');
  }
  const transcript = record(body.transcript, 'meeting-detail.transcript');
  exactKeys(transcript, ['blocks', 'correction', 'continuation'], 'meeting-detail.transcript');
  if (!Array.isArray(transcript.blocks)) throw new MkcReleaseAContractError('meeting-detail.transcript.blocks');
  const correction = transcript.correction === null ? null : record(transcript.correction, 'meeting-detail.transcript.correction');
  if (correction) exactKeys(correction, ['correction_key', 'body', 'occurred_at'], 'meeting-detail.transcript.correction');
  const continuation = record(transcript.continuation, 'meeting-detail.transcript.continuation');
  exactKeys(continuation, ['schema_version', 'total_units', 'transcript_sha256', 'url'], 'meeting-detail.transcript.continuation');
  if (continuation.schema_version !== 'mkc.meeting-transcript-page.v1') throw new MkcReleaseAContractError('meeting-detail.transcript.continuation.schema_version');
  const expectedTranscriptPath = `/v1/meetings/${encodeURIComponent(sourceKey)}/transcript`;
  if (continuation.url !== expectedTranscriptPath) throw new MkcReleaseAContractError('meeting-detail.transcript.continuation.url');
  return {
    schema_version: 'mkc.meeting-detail.v1',
    source_key: sourceKey,
    title: string(body.title, 'meeting-detail.title'),
    occurred_at: isoDate(body.occurred_at, 'meeting-detail.occurred_at'),
    ingested_at: isoDate(body.ingested_at, 'meeting-detail.ingested_at'),
    readiness: readiness(body.readiness, 'meeting-detail.readiness'),
    duration_seconds: nullableDuration(body.duration_seconds, 'meeting-detail.duration_seconds'),
    provenance: {
      kind: 'maina_app',
      platform: provenance.platform,
      captured_at: provenance.captured_at === null ? null : isoDate(provenance.captured_at, 'meeting-detail.provenance.captured_at'),
      client_schema_version: nullableString(provenance.client_schema_version, 'meeting-detail.provenance.client_schema_version'),
    },
    workspace: record(body.workspace, 'meeting-detail.workspace'),
    project: record(body.project, 'meeting-detail.project'),
    topics: recordArray(body.topics, 'meeting-detail.topics'),
    summary: nullableString(body.summary, 'meeting-detail.summary'),
    decisions: stringArray(body.decisions, 'meeting-detail.decisions'),
    todos: stringArray(body.todos, 'meeting-detail.todos'),
    open_questions: stringArray(body.open_questions, 'meeting-detail.open_questions'),
    important_points: stringArray(body.important_points, 'meeting-detail.important_points'),
    transcript: {
      blocks: transcript.blocks.map((item, index) => transcriptUnit(item, `meeting-detail.transcript.blocks[${index}]`, true)),
      correction: correction ? {
        correction_key: nonEmptyString(correction.correction_key, 'meeting-detail.transcript.correction.correction_key'),
        body: string(correction.body, 'meeting-detail.transcript.correction.body'),
        occurred_at: isoDate(correction.occurred_at, 'meeting-detail.transcript.correction.occurred_at'),
      } : null,
      continuation: {
        schema_version: 'mkc.meeting-transcript-page.v1',
        total_units: integer(continuation.total_units, 'meeting-detail.transcript.continuation.total_units'),
        transcript_sha256: checksum(continuation.transcript_sha256, 'meeting-detail.transcript.continuation.transcript_sha256'),
        url: expectedTranscriptPath,
      },
    },
    corrections: recordArray(body.corrections, 'meeting-detail.corrections'),
    current_field_versions: recordArray(body.current_field_versions, 'meeting-detail.current_field_versions'),
    correction_targets_url: string(body.correction_targets_url, 'meeting-detail.correction_targets_url'),
  };
}

export type MeetingLibraryQuery = {
  query?: string;
  occurredFrom?: string;
  occurredToExclusive?: string;
  readiness?: MeetingReadiness;
  sort?: 'newest' | 'oldest';
  pageSize?: number;
  cursor?: string;
};

function append(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') params.set(key, value);
}

function boundedPageSize(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new MkcReleaseAContractError('query.page_size');
  return String(value);
}

export function buildMeetingLibraryPath(query: MeetingLibraryQuery = {}): string {
  const params = new URLSearchParams();
  append(params, 'q', query.query?.trim());
  append(params, 'occurred_from', query.occurredFrom);
  append(params, 'occurred_to', query.occurredToExclusive);
  append(params, 'readiness', query.readiness);
  append(params, 'sort', query.sort);
  append(params, 'page_size', boundedPageSize(query.pageSize));
  append(params, 'cursor', query.cursor);
  const suffix = params.toString();
  return suffix ? `/v1/meetings?${suffix}` : '/v1/meetings';
}

export function buildMeetingDetailPath(sourceKey: string): string {
  return `/v1/meetings/${encodeURIComponent(nonEmptyString(sourceKey, 'sourceKey'))}`;
}

export function buildMeetingTranscriptPath(input: {
  sourceKey: string;
  pageSize?: number;
  cursor?: string;
}): string {
  const params = new URLSearchParams();
  append(params, 'page_size', boundedPageSize(input.pageSize));
  append(params, 'cursor', input.cursor);
  const suffix = params.toString();
  return `${buildMeetingDetailPath(input.sourceKey)}/transcript${suffix ? `?${suffix}` : ''}`;
}
