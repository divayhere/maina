/**
 * Meetings repository — the only place SQL for meetings lives. UI and state
 * talk to these functions, never to the DB directly (swap-seam: storage).
 */
import { getDb } from './db';
import { log } from '../services/logger';
import { splitTranscriptChunks, transcriptWordCount } from '../core/transcription/transcript';
import { normalizeNativeBlockTimeline } from '../core/transcription/nativeBlockTiming';
import {
  deriveNativeTranscriptOutcome,
  shouldImportNativePostProcessingResult,
  shouldRepairNativeTranscriptStatus,
} from '../services/nativePostProcessingCore';
import { deriveStageTransition } from '../core/pipeline/stageState';

export type MeetingStatus =
  | 'recording'
  | 'interrupted'
  | 'recorded'
  | 'transcribing'
  | 'transcript_partial'
  | 'audio_expired_incomplete'
  | 'transcribed'
  | 'summarizing'
  | 'summarized';

export type SummaryStatus = 'idle' | 'queued' | 'running' | 'ready' | 'failed';
export type MeetingPipelineStage =
  | 'recording'
  | 'audio_finalized'
  | 'asr'
  | 'transcript_durable'
  | 'summary'
  | 'mkc';
export type MeetingPipelineStageState = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'deferred';

export interface MeetingPipelineStageStatus {
  meetingId: string;
  stage: MeetingPipelineStage;
  state: MeetingPipelineStageState;
  attemptCount: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  updatedAt: number;
  lastError?: string | null;
  completedUnits: number;
  totalUnits: number;
  metadata?: Record<string, unknown> | null;
}
export type KnowledgeCloudSyncStatus =
  | 'local_only'
  | 'sync_queued'
  | 'syncing'
  | 'sync_succeeded'
  | 'sync_failed_auth'
  | 'sync_failed_retryable'
  | 'sync_failed_conflict'
  | 'sync_failed_validation'
  | 'sync_blocked_budget';

export interface KnowledgeCloudCorrection {
  correctionKey: string;
  meetingId: string;
  sourceKey: string;
  fieldPath: string;
  versionNumber: number;
  versionTag: string;
  supersedesCorrectionKey?: string | null;
  payloadJson: string;
  valueFingerprint: string;
  syncStatus: KnowledgeCloudSyncStatus;
  canonicalSha256?: string | null;
  lastAttemptAt?: number | null;
  syncedAt?: number | null;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface KnowledgeCloudCorrectionRow {
  correction_key: string;
  meeting_id: string;
  source_key: string;
  field_path: string;
  version_number: number;
  version_tag: string;
  supersedes_correction_key: string | null;
  payload_json: string;
  value_fingerprint: string;
  sync_status: KnowledgeCloudSyncStatus;
  canonical_sha256: string | null;
  last_attempt_at: number | null;
  synced_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const toKnowledgeCloudCorrection = (row: KnowledgeCloudCorrectionRow): KnowledgeCloudCorrection => ({
  correctionKey: row.correction_key,
  meetingId: row.meeting_id,
  sourceKey: row.source_key,
  fieldPath: row.field_path,
  versionNumber: row.version_number,
  versionTag: row.version_tag,
  supersedesCorrectionKey: row.supersedes_correction_key,
  payloadJson: row.payload_json,
  valueFingerprint: row.value_fingerprint,
  syncStatus: row.sync_status,
  canonicalSha256: row.canonical_sha256,
  lastAttemptAt: row.last_attempt_at,
  syncedAt: row.synced_at,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  durationMs: number;
  audioDurationMs: number;
  captureEndedAt?: number | null;
  audioUri?: string | null; // recording folder (segments) or null after cleanup
  transcript?: string | null;
  summary?: string | null;
  decisions: string[];
  openQuestions: string[];
  language?: string | null;
  status: MeetingStatus;
  summaryStatus: SummaryStatus;
  summaryProviderId?: string | null;
  summaryModel?: string | null;
  summarizedAt?: number | null;
  segmentCount: number;
  transcribedSegments: number;
  transcriptionWindowCount: number;
  transcriptionCompletedWindows: number;
  transcriptionFailedWindows: number;
  transcriptionRecoveryRounds: number;
  openTodoCount: number;
  totalTodoCount: number;
  updatedAt: number;
  lastError?: string | null;
  restartCount: number;
  knowledgeCloudSyncStatus: KnowledgeCloudSyncStatus;
  knowledgeCloudSourceKey?: string | null;
  knowledgeCloudPayloadJson?: string | null;
  knowledgeCloudSyncedAt?: number | null;
  knowledgeCloudLastAttemptAt?: number | null;
  knowledgeCloudError?: string | null;
  knowledgeCloudCanonicalSha256?: string | null;
  cloudNotesJobId?: string | null;
  cloudNotesLastPolledAt?: number | null;
  cloudNotesRetryCount?: number | null;
  cloudNotesLastRetryAt?: number | null;
  nativePostprocessRunId?: string | null;
  nativePostprocessImportedAt?: number | null;
}

interface Row {
  id: string;
  title: string;
  started_at: number;
  duration_ms: number;
  audio_duration_ms: number;
  capture_ended_at: number | null;
  audio_uri: string | null;
  transcript: string | null;
  summary: string | null;
  decisions_json: string | null;
  open_questions_json: string | null;
  language: string | null;
  status: MeetingStatus;
  summary_status: SummaryStatus;
  summary_provider_id: string | null;
  summary_model: string | null;
  summarized_at: number | null;
  segment_count: number;
  transcribed_segments: number;
  transcription_window_count: number;
  transcription_completed_windows: number;
  transcription_failed_windows: number;
  transcription_recovery_rounds: number;
  open_todo_count?: number | null;
  total_todo_count?: number | null;
  updated_at: number;
  last_error: string | null;
  restart_count: number;
  knowledge_cloud_sync_status: KnowledgeCloudSyncStatus;
  knowledge_cloud_source_key: string | null;
  knowledge_cloud_payload_json: string | null;
  knowledge_cloud_synced_at: number | null;
  knowledge_cloud_last_attempt_at: number | null;
  knowledge_cloud_error: string | null;
  knowledge_cloud_canonical_sha256: string | null;
  cloud_notes_job_id: string | null;
  cloud_notes_last_polled_at: number | null;
  cloud_notes_retry_count: number | null;
  cloud_notes_last_retry_at: number | null;
  native_postprocess_run_id: string | null;
  native_postprocess_imported_at: number | null;
}

function parseJsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stringifyJsonList(value: string[] | undefined | null): string | null {
  if (!value || value.length === 0) return null;
  return JSON.stringify(
    value
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

const toMeeting = (r: Row): Meeting => ({
  id: r.id,
  title: r.title,
  startedAt: r.started_at,
  durationMs: r.duration_ms,
  audioDurationMs: r.audio_duration_ms ?? 0,
  captureEndedAt: r.capture_ended_at,
  audioUri: r.audio_uri,
  transcript: r.transcript,
  summary: r.summary,
  decisions: parseJsonList(r.decisions_json),
  openQuestions: parseJsonList(r.open_questions_json),
  language: r.language,
  status: r.status,
  summaryStatus: r.summary_status ?? 'idle',
  summaryProviderId: r.summary_provider_id,
  summaryModel: r.summary_model,
  summarizedAt: r.summarized_at,
  segmentCount: r.segment_count ?? 0,
  transcribedSegments: r.transcribed_segments ?? 0,
  transcriptionWindowCount: r.transcription_window_count ?? 0,
  transcriptionCompletedWindows: r.transcription_completed_windows ?? 0,
  transcriptionFailedWindows: r.transcription_failed_windows ?? 0,
  transcriptionRecoveryRounds: r.transcription_recovery_rounds ?? 0,
  openTodoCount: r.open_todo_count ?? 0,
  totalTodoCount: r.total_todo_count ?? 0,
  updatedAt: r.updated_at || r.started_at,
  lastError: r.last_error,
  restartCount: r.restart_count ?? 0,
  knowledgeCloudSyncStatus: r.knowledge_cloud_sync_status ?? 'local_only',
  knowledgeCloudSourceKey: r.knowledge_cloud_source_key,
  knowledgeCloudPayloadJson: r.knowledge_cloud_payload_json,
  knowledgeCloudSyncedAt: r.knowledge_cloud_synced_at,
  knowledgeCloudLastAttemptAt: r.knowledge_cloud_last_attempt_at,
  knowledgeCloudError: r.knowledge_cloud_error,
  knowledgeCloudCanonicalSha256: r.knowledge_cloud_canonical_sha256,
  cloudNotesJobId: r.cloud_notes_job_id,
  cloudNotesLastPolledAt: r.cloud_notes_last_polled_at,
  cloudNotesRetryCount: r.cloud_notes_retry_count ?? 0,
  cloudNotesLastRetryAt: r.cloud_notes_last_retry_at,
  nativePostprocessRunId: r.native_postprocess_run_id,
  nativePostprocessImportedAt: r.native_postprocess_imported_at,
});

export interface TodoItem {
  id: string;
  meetingId: string;
  text: string;
  done: boolean;
  origin: 'ai' | 'manual';
  sourceQuote?: string | null;
  sourceSpeakerId?: string | null;
  sourceTimestamp?: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

interface TodoRow {
  id: string;
  meeting_id: string;
  text: string;
  done: number;
  origin: 'ai' | 'manual';
  source_quote: string | null;
  source_speaker_id: string | null;
  source_timestamp: number | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

const toTodoItem = (row: TodoRow): TodoItem => ({
  id: row.id,
  meetingId: row.meeting_id,
  text: row.text,
  done: row.done === 1,
  origin: row.origin,
  sourceQuote: row.source_quote,
  sourceSpeakerId: row.source_speaker_id,
  sourceTimestamp: row.source_timestamp,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface RecordingSegment {
  meetingId: string;
  index: number;
  audioUri: string;
  startedAt: number;
  endedAt?: number | null;
  status: 'recording' | 'recorded' | 'failed';
  errorCode?: string | null;
}

export type TranscriptBlockStatus = 'draft' | 'final';

export interface TranscriptBlock {
  blockId: string;
  meetingId: string;
  sequence: number;
  status: TranscriptBlockStatus;
  segmentIndex?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  language?: string | null;
  speakerId?: string | null;
  text: string;
  wordCount: number;
  charCount: number;
  createdAt: number;
  updatedAt: number;
  isLegacy?: boolean;
}

interface TranscriptBlockRow {
  block_id: string;
  meeting_id: string;
  sequence: number;
  status: TranscriptBlockStatus;
  segment_index: number | null;
  started_at: number | null;
  ended_at: number | null;
  language: string | null;
  speaker_id: string | null;
  text: string;
  word_count: number;
  char_count: number;
  created_at: number;
  updated_at: number;
}

export interface TranscriptPage {
  blocks: TranscriptBlock[];
  hasMore: boolean;
  source: 'blocks' | 'legacy' | 'empty';
  totalBlocks: number;
}

export interface TranscriptSummary {
  source: 'blocks' | 'legacy' | 'empty';
  blockCount: number;
  wordCount: number;
  charCount: number;
  latestSequence: number | null;
  hasDraft: boolean;
  hasText: boolean;
}

const toTranscriptBlock = (row: TranscriptBlockRow): TranscriptBlock => ({
  blockId: row.block_id,
  meetingId: row.meeting_id,
  sequence: row.sequence,
  status: row.status,
  segmentIndex: row.segment_index,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  language: row.language,
  speakerId: row.speaker_id,
  text: row.text,
  wordCount: row.word_count,
  charCount: row.char_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function legacyTranscriptBlock(meeting: Meeting): TranscriptBlock | null {
  const text = meeting.transcript?.trim();
  if (!text) return null;
  return {
    blockId: `legacy-${meeting.id}`,
    meetingId: meeting.id,
    sequence: 0,
    status: 'final',
    segmentIndex: null,
    startedAt: meeting.startedAt,
    endedAt: meeting.startedAt + meeting.durationMs,
    language: meeting.language ?? null,
    speakerId: null,
    text,
    wordCount: transcriptWordCount(text),
    charCount: text.length,
    createdAt: meeting.startedAt,
    updatedAt: meeting.updatedAt,
    isLegacy: true,
  };
}

function formatBlockTimestamp(at?: number | null): string {
  if (!at || !Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export async function createMeeting(m: {
  id: string;
  title: string;
  startedAt: number;
  durationMs: number;
  audioDurationMs?: number;
  captureEndedAt?: number | null;
  audioUri?: string | null;
  segmentCount?: number;
  status?: MeetingStatus;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO meetings (id, title, started_at, duration_ms, audio_uri, status, segment_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.title,
      m.startedAt,
      m.durationMs,
      m.audioUri ?? null,
      m.status ?? 'recorded',
      m.segmentCount ?? 0,
      Date.now(),
    ],
  );
  await updateMeetingPipelineStage({
    meetingId: m.id,
    stage: 'recording',
    state: m.status === 'recording' ? 'running' : 'pending',
    completedUnits: 0,
    totalUnits: 0,
  });
  log.info('meetings', 'created', { id: m.id, durationMs: m.durationMs, segments: m.segmentCount ?? 0 });
}

export async function listMeetings(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(`
    SELECT m.*,
           (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
           (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
    FROM meetings m
    ORDER BY m.started_at DESC
  `);
  return rows.map(toMeeting);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>(
    `SELECT m.*,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
     FROM meetings m
     WHERE m.id = ?`,
    [id],
  );
  return row ? toMeeting(row) : null;
}

export async function listMeetingsNeedingSummary(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT m.*,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
     FROM meetings m
     WHERE m.summary_status IN ('queued', 'running')
     ORDER BY m.started_at DESC`,
  );
  return rows.map(toMeeting);
}

export async function listMeetingsEligibleForSummaryQueue(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT m.*,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
     FROM meetings m
     WHERE m.status IN ('transcribed', 'summarizing', 'summarized')
       AND m.summary_status IN ('idle', 'failed', 'queued', 'running')
     ORDER BY m.started_at DESC`,
  );
  return rows.map(toMeeting);
}

export async function listMeetingsNeedingKnowledgeCloudSync(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT m.*,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
     FROM meetings m
     WHERE m.knowledge_cloud_sync_status IN ('sync_queued', 'syncing', 'sync_failed_retryable', 'sync_blocked_budget')
     ORDER BY m.started_at DESC`,
  );
  return rows.map(toMeeting);
}

export async function listMeetingsEligibleForKnowledgeCloudQueue(): Promise<Meeting[]> {
  return listMeetingsEligibleForKnowledgeCloudQueueWithOptions();
}

export async function listMeetingsEligibleForKnowledgeCloudQueueWithOptions(options?: {
  includeAuthFailures?: boolean;
}): Promise<Meeting[]> {
  const db = await getDb();
  const eligibleStatuses = options?.includeAuthFailures
    ? `'local_only', 'sync_failed_auth', 'sync_failed_retryable', 'sync_blocked_budget'`
    : `'local_only', 'sync_failed_retryable', 'sync_blocked_budget'`;
  const rows = await db.getAllAsync<Row>(
    `SELECT m.*,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todo_count,
            (SELECT COUNT(*) FROM todo_items t WHERE t.meeting_id = m.id) AS total_todo_count
     FROM meetings m
     WHERE m.status IN ('transcribed', 'summarized')
       AND m.summary_status NOT IN ('queued', 'running')
       AND m.knowledge_cloud_sync_status IN (${eligibleStatuses})
     ORDER BY m.started_at DESC`,
  );
  return rows.map(toMeeting);
}

export async function insertKnowledgeCloudCorrection(input: {
  correctionKey: string;
  meetingId: string;
  sourceKey: string;
  fieldPath: string;
  versionNumber: number;
  versionTag: string;
  supersedesCorrectionKey?: string | null;
  payloadJson: string;
  valueFingerprint: string;
}): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.runAsync(
    `INSERT OR IGNORE INTO knowledge_cloud_corrections (
       correction_key, meeting_id, source_key, field_path, version_number,
       version_tag, supersedes_correction_key, payload_json, value_fingerprint,
       sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sync_queued', ?, ?)`,
    [
      input.correctionKey,
      input.meetingId,
      input.sourceKey,
      input.fieldPath,
      input.versionNumber,
      input.versionTag,
      input.supersedesCorrectionKey ?? null,
      input.payloadJson,
      input.valueFingerprint,
      now,
      now,
    ],
  );
  return result.changes > 0;
}

export async function getLatestKnowledgeCloudCorrection(
  meetingId: string,
  fieldPath: string,
): Promise<KnowledgeCloudCorrection | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<KnowledgeCloudCorrectionRow>(
    `SELECT * FROM knowledge_cloud_corrections
     WHERE meeting_id = ? AND field_path = ?
     ORDER BY version_number DESC
     LIMIT 1`,
    [meetingId, fieldPath],
  );
  return row ? toKnowledgeCloudCorrection(row) : null;
}

export async function getKnowledgeCloudCorrection(
  correctionKey: string,
): Promise<KnowledgeCloudCorrection | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<KnowledgeCloudCorrectionRow>(
    'SELECT * FROM knowledge_cloud_corrections WHERE correction_key = ?',
    [correctionKey],
  );
  return row ? toKnowledgeCloudCorrection(row) : null;
}

export async function listKnowledgeCloudCorrections(
  meetingId: string,
): Promise<KnowledgeCloudCorrection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<KnowledgeCloudCorrectionRow>(
    `SELECT * FROM knowledge_cloud_corrections
     WHERE meeting_id = ?
     ORDER BY created_at DESC, field_path ASC`,
    [meetingId],
  );
  return rows.map(toKnowledgeCloudCorrection);
}

export async function listKnowledgeCloudCorrectionsNeedingSync(): Promise<KnowledgeCloudCorrection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<KnowledgeCloudCorrectionRow>(
    `SELECT c.*
     FROM knowledge_cloud_corrections c
     JOIN meetings m ON m.id = c.meeting_id
     WHERE m.knowledge_cloud_sync_status = 'sync_succeeded'
       AND c.sync_status IN ('sync_queued', 'syncing', 'sync_failed_retryable', 'sync_blocked_budget')
     ORDER BY c.meeting_id ASC, c.field_path ASC, c.version_number ASC`,
  );
  return rows.map(toKnowledgeCloudCorrection);
}

export async function listMeetingKnowledgeCloudCorrectionsNeedingSync(
  meetingId: string,
): Promise<KnowledgeCloudCorrection[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<KnowledgeCloudCorrectionRow>(
    `SELECT c.*
     FROM knowledge_cloud_corrections c
     JOIN meetings m ON m.id = c.meeting_id
     WHERE c.meeting_id = ?
       AND m.knowledge_cloud_sync_status = 'sync_succeeded'
       AND c.sync_status IN ('sync_queued', 'syncing', 'sync_failed_retryable', 'sync_blocked_budget')
     ORDER BY c.field_path ASC, c.version_number ASC`,
    [meetingId],
  );
  return rows.map(toKnowledgeCloudCorrection);
}

export async function listKnowledgeCloudCorrectionsEligibleForQueue(options?: {
  includeAuthFailures?: boolean;
}): Promise<KnowledgeCloudCorrection[]> {
  const db = await getDb();
  const eligibleStatuses = options?.includeAuthFailures
    ? `'sync_failed_auth', 'sync_failed_retryable', 'sync_blocked_budget'`
    : `'sync_failed_retryable', 'sync_blocked_budget'`;
  const rows = await db.getAllAsync<KnowledgeCloudCorrectionRow>(
    `SELECT c.*
     FROM knowledge_cloud_corrections c
     JOIN meetings m ON m.id = c.meeting_id
     WHERE m.knowledge_cloud_sync_status = 'sync_succeeded'
       AND c.sync_status IN (${eligibleStatuses})
     ORDER BY c.meeting_id ASC, c.field_path ASC, c.version_number ASC`,
  );
  return rows.map(toKnowledgeCloudCorrection);
}

export async function updateKnowledgeCloudCorrection(
  correctionKey: string,
  patch: Partial<Pick<KnowledgeCloudCorrection,
    | 'syncStatus'
    | 'canonicalSha256'
    | 'lastAttemptAt'
    | 'syncedAt'
    | 'error'
  >>,
): Promise<void> {
  const map: Record<string, string> = {
    syncStatus: 'sync_status',
    canonicalSha256: 'canonical_sha256',
    lastAttemptAt: 'last_attempt_at',
    syncedAt: 'synced_at',
    error: 'error',
  };
  const columns: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(map)) {
    if (key in patch) {
      columns.push(`${column} = ?`);
      values.push((patch as Record<string, string | number | null | undefined>)[key] ?? null);
    }
  }
  if (columns.length === 0) return;
  columns.push('updated_at = ?');
  values.push(Date.now(), correctionKey);
  const db = await getDb();
  await db.runAsync(
    `UPDATE knowledge_cloud_corrections SET ${columns.join(', ')} WHERE correction_key = ?`,
    values,
  );
}

export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<void> {
  const map: Record<string, string> = {
    title: 'title',
    durationMs: 'duration_ms',
    audioDurationMs: 'audio_duration_ms',
    captureEndedAt: 'capture_ended_at',
    audioUri: 'audio_uri',
    transcript: 'transcript',
    summary: 'summary',
    decisions: 'decisions_json',
    openQuestions: 'open_questions_json',
    language: 'language',
    status: 'status',
    summaryStatus: 'summary_status',
    summaryProviderId: 'summary_provider_id',
    summaryModel: 'summary_model',
    summarizedAt: 'summarized_at',
    segmentCount: 'segment_count',
    transcribedSegments: 'transcribed_segments',
    transcriptionWindowCount: 'transcription_window_count',
    transcriptionCompletedWindows: 'transcription_completed_windows',
    transcriptionFailedWindows: 'transcription_failed_windows',
    transcriptionRecoveryRounds: 'transcription_recovery_rounds',
    updatedAt: 'updated_at',
    lastError: 'last_error',
    restartCount: 'restart_count',
    knowledgeCloudSyncStatus: 'knowledge_cloud_sync_status',
    knowledgeCloudSourceKey: 'knowledge_cloud_source_key',
    knowledgeCloudPayloadJson: 'knowledge_cloud_payload_json',
    knowledgeCloudSyncedAt: 'knowledge_cloud_synced_at',
    knowledgeCloudLastAttemptAt: 'knowledge_cloud_last_attempt_at',
    knowledgeCloudError: 'knowledge_cloud_error',
    knowledgeCloudCanonicalSha256: 'knowledge_cloud_canonical_sha256',
    cloudNotesJobId: 'cloud_notes_job_id',
    cloudNotesLastPolledAt: 'cloud_notes_last_polled_at',
    cloudNotesRetryCount: 'cloud_notes_retry_count',
    cloudNotesLastRetryAt: 'cloud_notes_last_retry_at',
    nativePostprocessRunId: 'native_postprocess_run_id',
    nativePostprocessImportedAt: 'native_postprocess_imported_at',
  };
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      cols.push(`${col} = ?`);
      if (k === 'decisions' || k === 'openQuestions') {
        vals.push(stringifyJsonList((patch as Record<string, string[] | null | undefined>)[k]));
      } else {
        vals.push((patch as Record<string, string | number | null | undefined>)[k] ?? null);
      }
    }
  }
  if (cols.length === 0) return;
  if (!('updatedAt' in patch)) {
    cols.push('updated_at = ?');
    vals.push(Date.now());
  }
  vals.push(id);
  const db = await getDb();
  await db.runAsync(`UPDATE meetings SET ${cols.join(', ')} WHERE id = ?`, vals);
}

type MeetingPipelineStageRow = {
  meeting_id: string;
  stage: MeetingPipelineStage;
  state: MeetingPipelineStageState;
  attempt_count: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  last_error: string | null;
  completed_units: number;
  total_units: number;
  metadata_json: string | null;
};

function parsePipelineMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toMeetingPipelineStage(row: MeetingPipelineStageRow): MeetingPipelineStageStatus {
  return {
    meetingId: row.meeting_id,
    stage: row.stage,
    state: row.state,
    attemptCount: Math.max(0, row.attempt_count),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
    completedUnits: Math.max(0, row.completed_units),
    totalUnits: Math.max(0, row.total_units),
    metadata: parsePipelineMetadata(row.metadata_json),
  };
}

/**
 * Writes one stage without deriving or mutating any other pipeline stage.
 * This is intentionally separate from `meetings.status`: a cloud failure must
 * never make a durable transcript look failed, and summary retries must not
 * erase capture evidence.
 */
export async function updateMeetingPipelineStage(input: {
  meetingId: string;
  stage: MeetingPipelineStage;
  state: MeetingPipelineStageState;
  completedUnits?: number;
  totalUnits?: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  now?: number;
}): Promise<MeetingPipelineStageStatus> {
  const db = await getDb();
  const now = input.now ?? Date.now();
  const existing = await db.getFirstAsync<MeetingPipelineStageRow>(
    `SELECT * FROM meeting_pipeline_stages WHERE meeting_id = ? AND stage = ?`,
    [input.meetingId, input.stage],
  );
  const transition = deriveStageTransition(existing && {
    state: existing.state,
    attemptCount: existing.attempt_count,
    startedAt: existing.started_at,
    completedUnits: existing.completed_units,
    totalUnits: existing.total_units,
  }, {
    state: input.state,
    completedUnits: input.completedUnits,
    totalUnits: input.totalUnits,
    now,
  });
  const metadataJson = input.metadata === undefined
    ? existing?.metadata_json ?? null
    : input.metadata == null ? null : JSON.stringify(input.metadata);
  const error = input.error === undefined
    ? existing?.last_error ?? null
    : input.error?.trim() || null;

  await db.runAsync(
    `INSERT INTO meeting_pipeline_stages (
       meeting_id, stage, state, attempt_count, started_at, finished_at,
       updated_at, last_error, completed_units, total_units, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id, stage) DO UPDATE SET
       state = excluded.state,
       attempt_count = excluded.attempt_count,
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       updated_at = excluded.updated_at,
       last_error = excluded.last_error,
       completed_units = excluded.completed_units,
       total_units = excluded.total_units,
       metadata_json = excluded.metadata_json`,
    [
      input.meetingId,
      input.stage,
      input.state,
      transition.attemptCount,
      transition.startedAt,
      transition.finishedAt,
      now,
      error,
      transition.completedUnits,
      transition.totalUnits,
      metadataJson,
    ],
  );
  return {
    meetingId: input.meetingId,
    stage: input.stage,
    state: input.state,
    attemptCount: transition.attemptCount,
    startedAt: transition.startedAt,
    finishedAt: transition.finishedAt,
    updatedAt: now,
    lastError: error,
    completedUnits: transition.completedUnits,
    totalUnits: transition.totalUnits,
    metadata: input.metadata === undefined ? parsePipelineMetadata(existing?.metadata_json ?? null) : input.metadata ?? null,
  };
}

export async function getMeetingPipelineStages(meetingId: string): Promise<MeetingPipelineStageStatus[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MeetingPipelineStageRow>(
    `SELECT * FROM meeting_pipeline_stages WHERE meeting_id = ? ORDER BY stage ASC`,
    [meetingId],
  );
  return rows.map(toMeetingPipelineStage);
}

/**
 * If the app was killed mid-recording, the row is left in 'recording'.
 * The transcript was persisted as it went, so recover it rather than lose it.
 */
export async function recoverInterruptedMeetings(excludedMeetingIds: string[] = []): Promise<number> {
  const db = await getDb();
  const exclusion = excludedMeetingIds.length > 0
    ? ` AND id NOT IN (${excludedMeetingIds.map(() => '?').join(', ')})`
    : '';
  const rows = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM meetings WHERE status = 'recording'${exclusion}`,
    excludedMeetingIds,
  );
  if (rows.length === 0) return 0;
  const rowIds = rows.map((row) => row.id);
  await db.runAsync(
    `UPDATE meetings SET status = 'interrupted', updated_at = ?
     WHERE id IN (${rowIds.map(() => '?').join(', ')})`,
    [Date.now(), ...rowIds],
  );
  log.warn('meetings', 'recovered interrupted meetings', { count: rows.length });
  return rows.length;
}

/**
 * An interruption is an honest warning, not a dead end. When the owner chooses
 * to keep the captured result, clear the exception state without deleting any
 * transcript text. This also lets the normal notes/sync pipeline continue.
 */
export async function acceptSavedMeetingResult(meetingId: string): Promise<void> {
  const [meeting, transcript] = await Promise.all([
    getMeeting(meetingId),
    getTranscriptSummary(meetingId),
  ]);
  if (!meeting) return;
  const status: MeetingStatus = meeting.summaryStatus === 'ready'
    ? 'summarized'
    : transcript.hasText
      ? 'transcribed'
      : 'recorded';
  await updateMeeting(meetingId, {
    status,
    lastError: null,
  });
  log.info('meetings', 'saved meeting result accepted by owner', {
    meetingId,
    status,
    transcriptBlocks: transcript.blockCount,
  });
}

export async function markMeetingsAudioDeleted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const result = await db.runAsync(
    `UPDATE meetings SET audio_uri = NULL, updated_at = ?
     WHERE audio_uri IS NOT NULL AND id IN (${placeholders})`,
    [Date.now(), ...ids],
  );
  if (result.changes > 0) log.info('meetings', 'synced diagnostic audio cleanup', { count: result.changes });
}

export async function startRecordingSegment(
  meetingId: string,
  index: number,
  audioUri: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO recording_segments
      (meeting_id, segment_index, audio_uri, started_at, status)
     VALUES (?, ?, ?, ?, 'recording')
     ON CONFLICT(meeting_id, segment_index) DO UPDATE SET
       audio_uri = excluded.audio_uri,
       started_at = excluded.started_at,
       ended_at = NULL,
       status = 'recording',
       error_code = NULL`,
    [meetingId, index, audioUri, Date.now()],
  );
}

export async function finishRecordingSegment(
  meetingId: string,
  index: number,
  audioUri: string | null,
  errorCode?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE recording_segments
     SET audio_uri = COALESCE(?, audio_uri), ended_at = ?, status = ?, error_code = ?
     WHERE meeting_id = ? AND segment_index = ?`,
    [audioUri, Date.now(), audioUri ? 'recorded' : 'failed', errorCode ?? null, meetingId, index],
  );
}

export async function listRecordingSegments(meetingId: string): Promise<RecordingSegment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    meeting_id: string;
    segment_index: number;
    audio_uri: string;
    started_at: number;
    ended_at: number | null;
    status: RecordingSegment['status'];
    error_code: string | null;
  }>(
    'SELECT * FROM recording_segments WHERE meeting_id = ? ORDER BY segment_index ASC',
    [meetingId],
  );
  return rows.map((row) => ({
    meetingId: row.meeting_id,
    index: row.segment_index,
    audioUri: row.audio_uri,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    errorCode: row.error_code,
  }));
}

async function nextTranscriptSequence(meetingId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ next_sequence: number }>(
    `SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
     FROM transcript_blocks
     WHERE meeting_id = ?`,
    [meetingId],
  );
  return row?.next_sequence ?? 0;
}

async function getDraftTranscriptBlock(meetingId: string): Promise<TranscriptBlock | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<TranscriptBlockRow>(
    `SELECT * FROM transcript_blocks
     WHERE meeting_id = ? AND status = 'draft'
     LIMIT 1`,
    [meetingId],
  );
  return row ? toTranscriptBlock(row) : null;
}

export async function upsertTranscriptDraftBlock(input: {
  meetingId: string;
  text: string;
  segmentIndex?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  language?: string | null;
  speakerId?: string | null;
}): Promise<TranscriptBlock | null> {
  const text = input.text.trim();
  if (!text) {
    await discardTranscriptDraftBlock(input.meetingId);
    return null;
  }
  const db = await getDb();
  const now = Date.now();
  const existing = await getDraftTranscriptBlock(input.meetingId);
  if (existing) {
    await db.runAsync(
      `UPDATE transcript_blocks
       SET text = ?, word_count = ?, char_count = ?, segment_index = ?, started_at = ?, ended_at = ?,
           language = ?, speaker_id = ?, updated_at = ?
       WHERE block_id = ?`,
      [
        text,
        transcriptWordCount(text),
        text.length,
        input.segmentIndex ?? existing.segmentIndex ?? null,
        input.startedAt ?? existing.startedAt ?? now,
        input.endedAt ?? now,
        input.language ?? existing.language ?? null,
        input.speakerId ?? existing.speakerId ?? null,
        now,
        existing.blockId,
      ],
    );
    return getDraftTranscriptBlock(input.meetingId);
  }

  const sequence = await nextTranscriptSequence(input.meetingId);
  const blockId = newId();
  await db.runAsync(
    `INSERT INTO transcript_blocks
      (block_id, meeting_id, sequence, status, segment_index, started_at, ended_at, language, speaker_id, text, word_count, char_count, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      blockId,
      input.meetingId,
      sequence,
      input.segmentIndex ?? null,
      input.startedAt ?? now,
      input.endedAt ?? now,
      input.language ?? null,
      input.speakerId ?? null,
      text,
      transcriptWordCount(text),
      text.length,
      now,
      now,
    ],
  );
  return getDraftTranscriptBlock(input.meetingId);
}

export async function discardTranscriptDraftBlock(meetingId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `DELETE FROM transcript_blocks
     WHERE meeting_id = ? AND status = 'draft'`,
    [meetingId],
  );
}

export async function commitTranscriptFinalBlocks(input: {
  meetingId: string;
  text: string;
  segmentIndex?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  language?: string | null;
  speakerId?: string | null;
  checkpoint?: {
    windowKey: string;
    chunkIndex: number;
    windowIndex: number;
    startedMs: number;
    endedMs: number;
  };
}): Promise<TranscriptBlock[]> {
  const normalized = input.text.trim();
  const db = await getDb();
  const draft = await getDraftTranscriptBlock(input.meetingId);
  if (!normalized) {
    if (draft) await discardTranscriptDraftBlock(input.meetingId);
    return [];
  }
  const chunks = splitTranscriptChunks(normalized);
  if (chunks.length === 0) {
    if (draft) await discardTranscriptDraftBlock(input.meetingId);
    return [];
  }

  const baseSequence = draft?.sequence ?? await nextTranscriptSequence(input.meetingId);
  const baseStartedAt = input.startedAt ?? draft?.startedAt ?? Date.now();
  const baseEndedAt = input.endedAt ?? draft?.endedAt ?? Date.now();
  const createdAt = Date.now();

  await db.withExclusiveTransactionAsync(async (transaction) => {
    if (draft) {
      await transaction.runAsync(`DELETE FROM transcript_blocks WHERE block_id = ?`, [draft.blockId]);
    }
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await transaction.runAsync(
        `INSERT INTO transcript_blocks
          (block_id, meeting_id, sequence, status, segment_index, started_at, ended_at, language, speaker_id, text, word_count, char_count, created_at, updated_at)
         VALUES (?, ?, ?, 'final', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          input.meetingId,
          baseSequence + index,
          input.segmentIndex ?? draft?.segmentIndex ?? null,
          baseStartedAt,
          baseEndedAt,
          input.language ?? draft?.language ?? null,
          input.speakerId ?? draft?.speakerId ?? null,
          chunk.text,
          chunk.wordCount,
          chunk.charCount,
          createdAt,
          createdAt,
        ],
      );
    }
    if (input.checkpoint) {
      await transaction.runAsync(
        `INSERT OR REPLACE INTO local_asr_windows
          (meeting_id, window_key, chunk_index, window_index, started_ms, ended_ms, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.meetingId,
          input.checkpoint.windowKey,
          input.checkpoint.chunkIndex,
          input.checkpoint.windowIndex,
          input.checkpoint.startedMs,
          input.checkpoint.endedMs,
          createdAt,
        ],
      );
    }
  });

  const rows = await db.getAllAsync<TranscriptBlockRow>(
    `SELECT * FROM transcript_blocks
     WHERE meeting_id = ? AND sequence >= ? AND sequence < ?
     ORDER BY sequence ASC`,
    [input.meetingId, baseSequence, baseSequence + chunks.length],
  );
  return rows.map(toTranscriptBlock);
}

export async function markLocalAsrWindowComplete(input: {
  meetingId: string;
  windowKey: string;
  chunkIndex: number;
  windowIndex: number;
  startedMs: number;
  endedMs: number;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO local_asr_windows
      (meeting_id, window_key, chunk_index, window_index, started_ms, ended_ms, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.meetingId, input.windowKey, input.chunkIndex, input.windowIndex, input.startedMs, input.endedMs, Date.now()],
  );
}

export async function listCompletedLocalAsrWindowKeys(meetingId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ window_key: string }>(
    'SELECT window_key FROM local_asr_windows WHERE meeting_id = ?',
    [meetingId],
  );
  return new Set(rows.map((row) => row.window_key));
}

export async function getLastFinalTranscriptText(meetingId: string): Promise<string> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ text: string }>(
    `SELECT text FROM transcript_blocks
     WHERE meeting_id = ? AND status = 'final'
     ORDER BY sequence DESC LIMIT 1`,
    [meetingId],
  );
  return row?.text?.trim() ?? '';
}

/**
 * Imports one completed native-ASR run. Native background work never opens
 * `maina.db`: it writes to its own outbox and this foreground-only transaction
 * becomes the sole writer of Expo's database. A stable run id makes a retry
 * harmless if Maina dies between import and acknowledgement.
 */
export async function importNativePostProcessingResult(input: {
  meetingId: string;
  runId: string;
  durationMs: number;
  audioDurationMs: number;
  captureEndedAt?: number | null;
  segmentCount: number;
  processedSegments: number;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  routeRestartCount: number;
  lastError?: string | null;
  blocks: {
    sequence: number;
    segmentIndex?: number | null;
    startedAt?: number | null;
    endedAt?: number | null;
    language?: string | null;
    text: string;
  }[];
}): Promise<'imported' | 'already_imported'> {
  const db = await getDb();
  const current = await db.getFirstAsync<{
    native_postprocess_run_id: string | null;
    status: MeetingStatus;
    started_at: number;
    transcription_window_count: number;
    transcription_completed_windows: number;
    transcription_failed_windows: number;
  }>(
    `SELECT native_postprocess_run_id, status, started_at,
            transcription_window_count, transcription_completed_windows, transcription_failed_windows
     FROM meetings WHERE id = ?`,
    [input.meetingId],
  );
  if (!current) return 'already_imported';

  const incomingHasText = input.blocks.some((block) => block.text.trim().length > 0);
  const incomingOutcome = deriveNativeTranscriptOutcome({
    hasText: incomingHasText,
    windowCount: input.windowCount,
    completedWindows: input.completedWindows,
    failedWindows: input.failedWindows,
    lastError: input.lastError,
  });
  if (!shouldImportNativePostProcessingResult({
    persistedRunId: current.native_postprocess_run_id,
    persistedWindowCount: current.transcription_window_count,
    persistedCompletedWindows: current.transcription_completed_windows,
    persistedFailedWindows: current.transcription_failed_windows,
    incomingRunId: input.runId,
    incomingWindowCount: input.windowCount,
    incomingCompletedWindows: input.completedWindows,
    incomingFailedWindows: input.failedWindows,
  })) {
    if (shouldRepairNativeTranscriptStatus({
      persistedStatus: current.status,
      incomingStatus: incomingOutcome.status,
    })) {
      await db.runAsync(
        `UPDATE meetings
         SET status = ?, last_error = ?, updated_at = ?
         WHERE id = ?
           AND status IN ('recording', 'interrupted', 'recorded', 'transcribing', 'transcript_partial', 'audio_expired_incomplete')`,
        [incomingOutcome.status, incomingOutcome.error, Date.now(), input.meetingId],
      );
      log.warn('meetings', 'repaired stale native transcript status from durable outbox', {
        meetingId: input.meetingId,
        runId: input.runId,
        from: current.status,
        to: incomingOutcome.status,
      });
      return 'imported';
    }
    return 'already_imported';
  }

  const blocks = normalizeNativeBlockTimeline(input.blocks
    .map((block) => ({ ...block, text: block.text.trim() }))
    .filter((block) => block.text.length > 0)
    .sort((left, right) => left.sequence - right.sequence), current.started_at, input.durationMs);
  const now = Date.now();
  const outcome = incomingOutcome;

  let didImport = false;
  await db.withExclusiveTransactionAsync(async (transaction) => {
    const inTransaction = await transaction.getFirstAsync<{
      native_postprocess_run_id: string | null;
      transcription_window_count: number;
      transcription_completed_windows: number;
      transcription_failed_windows: number;
    }>(
      `SELECT native_postprocess_run_id,
              transcription_window_count, transcription_completed_windows, transcription_failed_windows
       FROM meetings WHERE id = ?`,
      [input.meetingId],
    );
    if (!inTransaction || !shouldImportNativePostProcessingResult({
      persistedRunId: inTransaction.native_postprocess_run_id,
      persistedWindowCount: inTransaction.transcription_window_count,
      persistedCompletedWindows: inTransaction.transcription_completed_windows,
      persistedFailedWindows: inTransaction.transcription_failed_windows,
      incomingRunId: input.runId,
      incomingWindowCount: input.windowCount,
      incomingCompletedWindows: input.completedWindows,
      incomingFailedWindows: input.failedWindows,
    })) return;

    await transaction.runAsync('DELETE FROM transcript_blocks WHERE meeting_id = ?', [input.meetingId]);
    // AI-derived packet content must not pretend it describes a changed raw
    // transcript. Keep manually-created tasks, but clear machine-generated
    // tasks so the normal auto-summary path can recreate them truthfully.
    await transaction.runAsync(
      "DELETE FROM todo_items WHERE meeting_id = ? AND origin = 'ai'",
      [input.meetingId],
    );
    for (const block of blocks) {
      await transaction.runAsync(
        `INSERT INTO transcript_blocks
          (block_id, meeting_id, sequence, status, segment_index, started_at, ended_at, language, speaker_id, text, word_count, char_count, created_at, updated_at)
         VALUES (?, ?, ?, 'final', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          `native-${input.runId}-${block.sequence}`,
          input.meetingId,
          block.sequence,
          block.segmentIndex ?? null,
          block.startedAt ?? null,
          block.endedAt ?? null,
          block.language ?? 'auto',
          block.text,
          transcriptWordCount(block.text),
          block.text.length,
          now,
          now,
        ],
      );
    }
    await transaction.runAsync(
      `UPDATE meetings
       SET duration_ms = ?, audio_duration_ms = ?, capture_ended_at = ?,
           segment_count = ?, transcribed_segments = ?,
           transcription_window_count = ?, transcription_completed_windows = ?,
           transcription_failed_windows = ?, restart_count = ?,
           transcript = NULL, language = 'auto',
           status = ?, summary = NULL, decisions_json = NULL, open_questions_json = NULL,
           summary_status = 'idle', summary_provider_id = NULL, summary_model = NULL, summarized_at = NULL,
           last_error = ?, native_postprocess_run_id = ?, native_postprocess_imported_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        Math.max(0, input.durationMs),
        Math.max(0, input.audioDurationMs),
        input.captureEndedAt ?? null,
        Math.max(0, input.segmentCount),
        Math.max(0, input.processedSegments),
        Math.max(0, input.windowCount),
        Math.max(0, input.completedWindows),
        Math.max(0, input.failedWindows),
        Math.max(0, input.routeRestartCount),
        outcome.status,
        outcome.error,
        input.runId,
        now,
        now,
        input.meetingId,
      ],
    );
    didImport = true;
  });
  if (!didImport) return 'already_imported';
  log.info('meetings', 'native post-processing result imported', {
    meetingId: input.meetingId,
    runId: input.runId,
    blocks: blocks.length,
    completedWindows: input.completedWindows,
    failedWindows: input.failedWindows,
  });
  return 'imported';
}

export async function updateNativePostProcessingProgress(input: {
  meetingId: string;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  processedSegments: number;
  lastError?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE meetings
     SET status = CASE
           WHEN status IN ('recording', 'interrupted', 'recorded', 'transcribing') THEN 'transcribing'
           ELSE status
         END,
         transcription_window_count = ?, transcription_completed_windows = ?,
         transcription_failed_windows = ?, transcribed_segments = ?,
         last_error = ?, updated_at = ?
     WHERE id = ?`,
    [
      Math.max(0, input.windowCount),
      Math.max(0, input.completedWindows),
      Math.max(0, input.failedWindows),
      Math.max(0, input.processedSegments),
      input.lastError?.trim() || null,
      Date.now(),
      input.meetingId,
    ],
  );
}

export async function getTranscriptPage(
  meetingId: string,
  options?: { offset?: number; limit?: number; includeDraft?: boolean },
): Promise<TranscriptPage> {
  const offset = Math.max(0, options?.offset ?? 0);
  const limit = Math.max(1, options?.limit ?? 50);
  const includeDraft = options?.includeDraft ?? true;
  const db = await getDb();
  const countRow = await db.getFirstAsync<{ total: number; draft_count: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count
     FROM transcript_blocks
     WHERE meeting_id = ?`,
    [meetingId],
  );
  const total = countRow?.total ?? 0;
  if (total > 0) {
    const rows = await db.getAllAsync<TranscriptBlockRow>(
      `SELECT * FROM transcript_blocks
       WHERE meeting_id = ?
         AND (? = 1 OR status = 'final')
       ORDER BY sequence ASC
       LIMIT ? OFFSET ?`,
      [meetingId, includeDraft ? 1 : 0, limit, offset],
    );
    return {
      blocks: rows.map(toTranscriptBlock),
      hasMore: offset + rows.length < total,
      source: 'blocks',
      totalBlocks: total,
    };
  }
  const meeting = await getMeeting(meetingId);
  const legacy = meeting ? legacyTranscriptBlock(meeting) : null;
  if (!legacy) {
    return { blocks: [], hasMore: false, source: 'empty', totalBlocks: 0 };
  }
  const blocks = offset === 0 ? [legacy] : [];
  return {
    blocks,
    hasMore: false,
    source: 'legacy',
    totalBlocks: blocks.length,
  };
}

export async function listRecentTranscriptBlocks(
  meetingId: string,
  limit = 8,
): Promise<TranscriptBlock[]> {
  const page = await getTranscriptPage(meetingId, { limit, offset: 0, includeDraft: true });
  if (page.source !== 'blocks') return page.blocks;
  return page.blocks.slice(-limit);
}

export async function getTranscriptSummary(meetingId: string): Promise<TranscriptSummary> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    total: number;
    words: number | null;
    chars: number | null;
    latest_sequence: number | null;
    draft_count: number | null;
  }>(
    `SELECT COUNT(*) AS total,
            SUM(word_count) AS words,
            SUM(char_count) AS chars,
            MAX(sequence) AS latest_sequence,
            SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count
     FROM transcript_blocks
     WHERE meeting_id = ?`,
    [meetingId],
  );
  if ((row?.total ?? 0) > 0) {
    return {
      source: 'blocks',
      blockCount: row?.total ?? 0,
      wordCount: row?.words ?? 0,
      charCount: row?.chars ?? 0,
      latestSequence: row?.latest_sequence ?? null,
      hasDraft: (row?.draft_count ?? 0) > 0,
      hasText: (row?.chars ?? 0) > 0,
    };
  }
  const meeting = await getMeeting(meetingId);
  const legacy = meeting ? legacyTranscriptBlock(meeting) : null;
  if (!legacy) {
    return {
      source: 'empty',
      blockCount: 0,
      wordCount: 0,
      charCount: 0,
      latestSequence: null,
      hasDraft: false,
      hasText: false,
    };
  }
  return {
    source: 'legacy',
    blockCount: 1,
    wordCount: legacy.wordCount,
    charCount: legacy.charCount,
    latestSequence: legacy.sequence,
    hasDraft: false,
    hasText: true,
  };
}

export async function buildTranscriptText(
  meetingId: string,
  options?: { includeTimestamps?: boolean },
): Promise<{ text: string; blockCount: number; wordCount: number; source: 'blocks' | 'legacy' | 'empty' }> {
  const includeTimestamps = options?.includeTimestamps ?? true;
  let offset = 0;
  const limit = 100;
  let source: 'blocks' | 'legacy' | 'empty' = 'empty';
  const lines: string[] = [];
  let blockCount = 0;
  let wordCount = 0;

  while (true) {
    const page = await getTranscriptPage(meetingId, { offset, limit, includeDraft: true });
    if (source === 'empty') source = page.source;
    if (page.blocks.length === 0) break;
    page.blocks.forEach((block) => {
      if (!block.text.trim()) return;
      blockCount += 1;
      wordCount += block.wordCount;
      const prefix = includeTimestamps ? formatBlockTimestamp(block.startedAt) : '';
      lines.push(prefix ? `[${prefix}] ${block.text}` : block.text);
    });
    if (!page.hasMore || page.source !== 'blocks') break;
    offset += page.blocks.length;
  }

  return {
    text: lines.join('\n\n').trim(),
    blockCount,
    wordCount,
    source,
  };
}

export async function saveMeetingPacket(input: {
  meetingId: string;
  title?: string | null;
  summary?: string | null;
  decisions?: string[];
  openQuestions?: string[];
  providerId?: string | null;
  model?: string | null;
  summarizedAt?: number | null;
}): Promise<void> {
  await updateMeeting(input.meetingId, {
    title: input.title?.trim() || undefined,
    summary: input.summary?.trim() || null,
    decisions: input.decisions ?? [],
    openQuestions: input.openQuestions ?? [],
    summaryStatus: 'ready',
    summaryProviderId: input.providerId ?? null,
    summaryModel: input.model ?? null,
    summarizedAt: input.summarizedAt ?? Date.now(),
    status: 'summarized',
    lastError: null,
  });
  await updateMeetingPipelineStage({
    meetingId: input.meetingId,
    stage: 'summary',
    state: 'ready',
    completedUnits: 1,
    totalUnits: 1,
    error: null,
    metadata: {
      providerId: input.providerId ?? null,
      model: input.model ?? null,
    },
  });
}

export async function clearMeetingPacket(meetingId: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE meetings
       SET summary = NULL,
           decisions_json = NULL,
           open_questions_json = NULL,
           summary_status = 'idle',
           summary_provider_id = NULL,
           summary_model = NULL,
           summarized_at = NULL,
           status = CASE WHEN status = 'summarized' OR status = 'summarizing' THEN 'transcribed' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
      [Date.now(), meetingId],
    );
    await db.runAsync(`DELETE FROM todo_items WHERE meeting_id = ?`, [meetingId]);
  });
  await updateMeetingPipelineStage({
    meetingId,
    stage: 'summary',
    state: 'pending',
    completedUnits: 0,
    totalUnits: 0,
    error: null,
  });
}

export async function setMeetingSummaryState(
  meetingId: string,
  status: SummaryStatus,
  options?: { providerId?: string | null; model?: string | null; error?: string | null },
): Promise<void> {
  const nextMeetingStatus: MeetingStatus =
    status === 'ready'
      ? 'summarized'
      : status === 'running' || status === 'queued'
        ? 'summarizing'
        : 'transcribed';
  await updateMeeting(meetingId, {
    summaryStatus: status,
    summaryProviderId: options?.providerId ?? undefined,
    summaryModel: options?.model ?? undefined,
    lastError: options?.error ?? (status === 'failed' ? 'Summary generation failed' : null),
    status: nextMeetingStatus,
    summarizedAt: status === 'ready' ? Date.now() : undefined,
  });
  const stageState: MeetingPipelineStageState = status === 'idle'
    ? 'pending'
    : status === 'queued'
      ? 'queued'
      : status === 'running'
        ? 'running'
        : status === 'ready'
          ? 'ready'
          : 'failed';
  await updateMeetingPipelineStage({
    meetingId,
    stage: 'summary',
    state: stageState,
    completedUnits: status === 'ready' ? 1 : 0,
    totalUnits: 1,
    error: options?.error ?? (status === 'failed' ? 'Summary generation failed' : null),
    metadata: {
      providerId: options?.providerId ?? null,
      model: options?.model ?? null,
    },
  });
}

export async function replaceMeetingTodos(
  meetingId: string,
  todos: {
    text: string;
    done?: boolean;
    sourceQuote?: string | null;
    sourceSpeakerId?: string | null;
    sourceTimestamp?: number | null;
    origin?: 'ai' | 'manual';
  }[],
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM todo_items WHERE meeting_id = ? AND origin = 'ai'`, [meetingId]);
    for (let index = 0; index < todos.length; index += 1) {
      const todo = todos[index];
      const text = todo.text.trim();
      if (!text) continue;
      await db.runAsync(
        `INSERT INTO todo_items
          (id, meeting_id, text, done, source_quote, source_speaker_id, source_timestamp, sort_order, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          meetingId,
          text,
          todo.done ? 1 : 0,
          todo.sourceQuote ?? null,
          todo.sourceSpeakerId ?? null,
          todo.sourceTimestamp ?? null,
          index,
          todo.origin ?? 'ai',
          now,
          now,
        ],
      );
    }
  });
}

export async function listMeetingTodos(meetingId: string): Promise<TodoItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<TodoRow>(
    `SELECT * FROM todo_items
     WHERE meeting_id = ?
     ORDER BY done ASC, sort_order ASC, created_at ASC`,
    [meetingId],
  );
  return rows.map(toTodoItem);
}

export async function listTodos(options?: { done?: boolean }): Promise<TodoItem[]> {
  const db = await getDb();
  const rows = options?.done === undefined
    ? await db.getAllAsync<TodoRow>(
      `SELECT * FROM todo_items
       ORDER BY done ASC, updated_at DESC, created_at DESC`,
    )
    : await db.getAllAsync<TodoRow>(
      `SELECT * FROM todo_items
       WHERE done = ?
       ORDER BY updated_at DESC, created_at DESC`,
      [options.done ? 1 : 0],
    );
  return rows.map(toTodoItem);
}

export async function createManualTodo(meetingId: string, text: string): Promise<TodoItem | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const db = await getDb();
  const row = await db.getFirstAsync<{ next_sort: number }>(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
     FROM todo_items
     WHERE meeting_id = ?`,
    [meetingId],
  );
  const now = Date.now();
  const id = newId();
  await db.runAsync(
    `INSERT INTO todo_items
      (id, meeting_id, text, done, sort_order, origin, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, 'manual', ?, ?)`,
    [id, meetingId, trimmed, row?.next_sort ?? 0, now, now],
  );
  const created = await db.getFirstAsync<TodoRow>('SELECT * FROM todo_items WHERE id = ?', [id]);
  return created ? toTodoItem(created) : null;
}

export async function updateTodoDone(id: string, done: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE todo_items
     SET done = ?, updated_at = ?
     WHERE id = ?`,
    [done ? 1 : 0, Date.now(), id],
  );
}

export async function updateTodoText(id: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const db = await getDb();
  await db.runAsync(
    `UPDATE todo_items
     SET text = ?, updated_at = ?
     WHERE id = ?`,
    [trimmed, Date.now(), id],
  );
}

export async function deleteTodo(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM todo_items WHERE id = ?`, [id]);
}

export async function resetMeetingTranscript(meetingId: string): Promise<void> {
  await clearMeetingPacket(meetingId);
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM transcript_blocks WHERE meeting_id = ?`, [meetingId]);
    await db.runAsync(`DELETE FROM local_asr_windows WHERE meeting_id = ?`, [meetingId]);
    await db.runAsync(
      `UPDATE meetings
       SET transcript = NULL, transcribed_segments = 0,
           transcription_window_count = 0, transcription_completed_windows = 0,
           transcription_failed_windows = 0, transcription_recovery_rounds = 0,
           updated_at = ?, last_error = NULL, summary_status = 'idle'
       WHERE id = ?`,
      [Date.now(), meetingId],
    );
  });
}

export async function purgeStagingMeetings(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>(
    `SELECT * FROM meetings
     WHERE status != 'recording'
     ORDER BY started_at ASC`,
  );
  const meetings = rows.map(toMeeting);
  if (meetings.length === 0) return [];
  await db.withTransactionAsync(async () => {
    for (const meeting of meetings) {
      await db.runAsync('DELETE FROM meetings WHERE id = ?', [meeting.id]);
    }
  });
  log.warn('meetings', 'purged staging meetings', { count: meetings.length });
  return meetings;
}

export async function listInterruptedSegmentUris(): Promise<string[]> {
  return (await listInterruptedRecordingSegments()).map((segment) => segment.audioUri);
}

export async function listInterruptedRecordingSegments(): Promise<RecordingSegment[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    meeting_id: string;
    segment_index: number;
    audio_uri: string;
    started_at: number;
    ended_at: number | null;
    status: RecordingSegment['status'];
    error_code: string | null;
  }>(
    `SELECT rs.*
     FROM recording_segments rs
     JOIN meetings m ON m.id = rs.meeting_id
     WHERE m.status = 'recording'`,
  );
  return rows.map((row) => ({
    meetingId: row.meeting_id,
    index: row.segment_index,
    audioUri: row.audio_uri,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    errorCode: row.error_code,
  }));
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meetings WHERE id = ?', [id]);
  log.info('meetings', 'deleted', { id });
}
