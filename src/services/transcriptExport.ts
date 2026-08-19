import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { buildTranscriptText, listMeetingTodos, type Meeting } from '@/data/meetings';
import { formatDateTime, formatDuration } from '@/utils/format';

function bulletSection(title: string, values: string[]): string {
  if (values.length === 0) return `## ${title}\n\n- None`;
  return `## ${title}\n\n${values.map((item) => `- ${item}`).join('\n')}`;
}

export async function buildMeetingExportText(
  meeting: Meeting,
): Promise<{ text: string; transcriptText: string; blockCount: number; wordCount: number }> {
  const transcript = await buildTranscriptText(meeting.id, { includeTimestamps: true });
  const todos = await listMeetingTodos(meeting.id);
  const text = [
    `# ${meeting.title}`,
    '',
    `Date: ${formatDateTime(meeting.startedAt)}`,
    `Duration: ${formatDuration(meeting.durationMs)}`,
    `Language: ${meeting.language ?? 'Mixed / auto'}`,
    '',
    '## Summary',
    '',
    meeting.summary?.trim() || 'Not generated yet.',
    '',
    bulletSection('Decisions', meeting.decisions),
    '',
    bulletSection('To-dos', todos.map((todo) => `${todo.done ? '[x]' : '[ ]'} ${todo.text}`)),
    '',
    bulletSection('Open Questions', meeting.openQuestions),
    '',
    '## Transcript',
    '',
    transcript.text || '_No transcript_',
  ].join('\n');
  return {
    text,
    transcriptText: transcript.text,
    blockCount: transcript.blockCount,
    wordCount: transcript.wordCount,
  };
}

export async function writeMeetingExportFile(
  meeting: Meeting,
): Promise<{ uri: string; text: string; blockCount: number; wordCount: number }> {
  const built = await buildMeetingExportText(meeting);
  const safeTitle = meeting.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'meeting';
  const uri = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ''}${safeTitle}-${meeting.id}.md`;
  await FileSystem.writeAsStringAsync(uri, built.text, { encoding: FileSystem.EncodingType.UTF8 });
  return {
    uri,
    text: built.text,
    blockCount: built.blockCount,
    wordCount: built.wordCount,
  };
}

export async function shareMeetingExport(meeting: Meeting): Promise<void> {
  const file = await writeMeetingExportFile(meeting);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri);
    return;
  }
  throw new Error('File sharing is unavailable on this device.');
}
