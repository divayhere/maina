import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root || !existsSync(root)) throw new Error('A copied app-container directory is required.');

function walk(dir, predicate) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const found = walk(path, predicate);
      if (found) return found;
    } else if (predicate(path)) return path;
  }
  return null;
}

const db = walk(root, (path) => path.endsWith('/maina.db'));
if (!db) throw new Error('maina.db is missing from copied app data.');
const sqlite = (sql) => execFileSync('/usr/bin/sqlite3', [db, sql], { encoding: 'utf8' }).trim();
if (sqlite('PRAGMA integrity_check;') !== 'ok') throw new Error('Copied Maina database failed integrity_check.');
const count = (table) => Number(sqlite(`SELECT COUNT(*) FROM ${table};`));
const activeRecordings = Number(sqlite(
  `SELECT COUNT(*) FROM meetings WHERE status = 'recording';`,
));
const recoverableProcessingMeetings = Number(sqlite(
  `SELECT COUNT(*) FROM meetings WHERE status IN ('transcribing','summarizing');`,
));
const activeStages = Number(sqlite(
  `SELECT COUNT(*) FROM meeting_pipeline_stages WHERE state = 'running';`,
));
const hasDurableLog = Boolean(walk(root, (path) => path.endsWith('/maina-last-log.txt')));
const hasQwenModel = Boolean(walk(root, (path) => path.endsWith('/qwen3-asr-0.6b-int8/tokens.txt')));

process.stdout.write(JSON.stringify({
  meetings: count('meetings'),
  transcriptBlocks: count('transcript_blocks'),
  todos: count('todo_items'),
  pipelineStages: count('meeting_pipeline_stages'),
  // Keep activeMeetings as a compatibility alias, but define "active" as an
  // open microphone session. Transcription and summary work are durable and
  // deliberately safe to interrupt during an in-place certificate renewal.
  activeMeetings: activeRecordings,
  activeRecordings,
  recoverableProcessingMeetings,
  activeStages,
  hasDurableLog,
  hasQwenModel,
}));
