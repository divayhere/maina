/**
 * Meetings repository — the only place SQL for meetings lives. UI and state
 * talk to these functions, never to the DB directly (swap-seam: storage).
 */
import { getDb } from './db';
import { log } from '../services/logger';

export type MeetingStatus = 'recording' | 'recorded' | 'transcribing' | 'transcribed' | 'summarized';

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
});

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
    `INSERT INTO meetings (id, title, started_at, duration_ms, audio_uri, status, segment_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.title, m.startedAt, m.durationMs, m.audioUri ?? null, m.status ?? 'recorded', m.segmentCount ?? 0],
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
    "UPDATE meetings SET status = CASE WHEN transcript IS NOT NULL AND transcript != '' THEN 'transcribed' ELSE 'recorded' END WHERE status = 'recording'",
  );
  log.warn('meetings', 'recovered interrupted meetings', { count: rows.length });
  return rows.length;
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meetings WHERE id = ?', [id]);
  log.info('meetings', 'deleted', { id });
}
