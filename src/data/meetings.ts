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
  audioUri?: string | null;
  transcript?: string | null;
  summary?: string | null;
  language?: string | null;
  status: MeetingStatus;
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
  status?: MeetingStatus;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO meetings (id, title, started_at, duration_ms, audio_uri, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [m.id, m.title, m.startedAt, m.durationMs, m.audioUri ?? null, m.status ?? 'recorded'],
  );
  log.info('meetings', 'created', { id: m.id, durationMs: m.durationMs });
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
  log.info('meetings', 'updated', { id, fields: Object.keys(patch) });
}

export async function deleteMeeting(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM meetings WHERE id = ?', [id]);
  log.info('meetings', 'deleted', { id });
}
