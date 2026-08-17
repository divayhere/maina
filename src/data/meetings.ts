/**
 * Meetings repository — the only place SQL for meetings lives. UI and state
 * talk to these functions, never to the DB directly (swap-seam: storage).
 */
import { getDb } from './db';
import { log } from '../services/logger';

export type MeetingStatus =
  | 'recording'
  | 'interrupted'
  | 'recorded'
  | 'transcribing'
  | 'transcribed'
  | 'summarized';

export interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  durationMs: number;
  audioUri?: string | null; // recording folder (segments) or null after cleanup
  transcript?: string | null;
  summary?: string | null;
  language?: string | null;
  status: MeetingStatus;
  segmentCount: number;
  transcribedSegments: number;
  updatedAt: number;
  lastError?: string | null;
  restartCount: number;
}

interface Row {
  id: string;
  title: string;
  started_at: number;
  duration_ms: number;
  audio_uri: string | null;
  transcript: string | null;
  summary: string | null;
  language: string | null;
  status: MeetingStatus;
  segment_count: number;
  transcribed_segments: number;
  updated_at: number;
  last_error: string | null;
  restart_count: number;
}

const toMeeting = (r: Row): Meeting => ({
  id: r.id,
  title: r.title,
  startedAt: r.started_at,
  durationMs: r.duration_ms,
  audioUri: r.audio_uri,
  transcript: r.transcript,
  summary: r.summary,
  language: r.language,
  status: r.status,
  segmentCount: r.segment_count ?? 0,
  transcribedSegments: r.transcribed_segments ?? 0,
  updatedAt: r.updated_at || r.started_at,
  lastError: r.last_error,
  restartCount: r.restart_count ?? 0,
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

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export async function createMeeting(m: {
  id: string;
  title: string;
  startedAt: number;
  durationMs: number;
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
  log.info('meetings', 'created', { id: m.id, durationMs: m.durationMs, segments: m.segmentCount ?? 0 });
}

export async function listMeetings(): Promise<Meeting[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Row>('SELECT * FROM meetings ORDER BY started_at DESC');
  return rows.map(toMeeting);
}

export async function getMeeting(id: string): Promise<Meeting | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Row>('SELECT * FROM meetings WHERE id = ?', [id]);
  return row ? toMeeting(row) : null;
}

export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<void> {
  const map: Record<string, string> = {
    title: 'title',
    durationMs: 'duration_ms',
    audioUri: 'audio_uri',
    transcript: 'transcript',
    summary: 'summary',
    language: 'language',
    status: 'status',
    segmentCount: 'segment_count',
    transcribedSegments: 'transcribed_segments',
    updatedAt: 'updated_at',
    lastError: 'last_error',
    restartCount: 'restart_count',
  };
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) {
      cols.push(`${col} = ?`);
      vals.push((patch as Record<string, string | number | null | undefined>)[k] ?? null);
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

/**
 * If the app was killed mid-recording, the row is left in 'recording'.
 * The transcript was persisted as it went, so recover it rather than lose it.
 */
export async function recoverInterruptedMeetings(): Promise<number> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM meetings WHERE status = 'recording'",
  );
  if (rows.length === 0) return 0;
  await db.runAsync(
    "UPDATE meetings SET status = 'interrupted', updated_at = ? WHERE status = 'recording'",
    [Date.now()],
  );
  log.warn('meetings', 'recovered interrupted meetings', { count: rows.length });
  return rows.length;
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

export async function listInterruptedSegmentUris(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ audio_uri: string }>(
    `SELECT rs.audio_uri
     FROM recording_segments rs
     JOIN meetings m ON m.id = rs.meeting_id
     WHERE m.status = 'recording'`,
  );
  return rows.map((row) => row.audio_uri);
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meetings WHERE id = ?', [id]);
  log.info('meetings', 'deleted', { id });
}
