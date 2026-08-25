/**
 * Persisted key/value settings (SQLite). Speech language is intentionally
 * independent from the recognition implementation so engines remain swappable.
 */
import { getDb } from './db';
import { DEFAULT_LANGUAGE } from '../core/transcription/nativeSpeech';

const KEY_LANG = 'speech_language';

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function getLanguage(): Promise<string> {
  return (await getSetting(KEY_LANG)) ?? DEFAULT_LANGUAGE;
}

export async function setLanguage(code: string): Promise<void> {
  await setSetting(KEY_LANG, code);
}
