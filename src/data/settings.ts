/**
 * Persisted key/value settings (SQLite). Currently holds the selected Whisper
 * model so the user can switch models in-app without a rebuild.
 */
import { getDb } from './db';
import { DEFAULT_MODEL_ID } from '../core/transcription/models';
import { DEFAULT_LANGUAGE } from '../core/transcription/nativeSpeech';

const KEY_MODEL = 'transcription_model';
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

export async function getSelectedModel(): Promise<string> {
  return (await getSetting(KEY_MODEL)) ?? DEFAULT_MODEL_ID;
}

export async function setSelectedModel(id: string): Promise<void> {
  await setSetting(KEY_MODEL, id);
}

export async function getLanguage(): Promise<string> {
  return (await getSetting(KEY_LANG)) ?? DEFAULT_LANGUAGE;
}

export async function setLanguage(code: string): Promise<void> {
  await setSetting(KEY_LANG, code);
}
