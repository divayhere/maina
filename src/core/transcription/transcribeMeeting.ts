/**
 * Orchestrates transcription of a segmented recording: one segment at a time,
 * appending text and persisting progress after each. Resumable — if it crashes
 * or the model reloads, it continues from the last finished segment. The
 * recording (segments on disk) is the source of truth and is never touched
 * until the whole transcript is done.
 */
import * as FileSystem from 'expo-file-system/legacy';

import { getMeeting, updateMeeting } from '../../data/meetings';
import { segmentPath } from '../../hardware/recording/pcmRecorder';
import { DEFAULT_CONFIG } from '../../services/config';
import { log } from '../../services/logger';
import { whisperEngine } from './whisperEngine';

export async function transcribeMeeting(
  id: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const m = await getMeeting(id);
  if (!m) throw new Error('meeting-not-found');
  if (!m.audioUri) throw new Error('no-audio');
  const total = m.segmentCount;
  if (total === 0) throw new Error('no-segments');

  await whisperEngine.init(); // model must already be downloaded
  await updateMeeting(id, { status: 'transcribing' });

  let done = m.transcribedSegments ?? 0;
  let transcript = m.transcript ?? '';

  for (let i = done; i < total; i++) {
    const seg = segmentPath(m.audioUri, i);
    const info = await FileSystem.getInfoAsync(seg);
    if (!info.exists) {
      log.warn('transcribe', 'segment missing, skipping', { i });
      done = i + 1;
      await updateMeeting(id, { transcribedSegments: done });
      continue;
    }
    const res = await whisperEngine.transcribe(seg, { language: DEFAULT_CONFIG.transcriptionLanguage });
    transcript = (transcript + (transcript ? ' ' : '') + res.text).trim();
    done = i + 1;
    await updateMeeting(id, {
      transcript,
      transcribedSegments: done,
      language: res.language,
      status: done >= total ? 'transcribed' : 'transcribing',
    });
    onProgress?.(done, total);
    log.info('transcribe', 'segment done', { i, chars: res.text.length, lang: res.language, ms: res.durationMs });
  }

  // Privacy: delete the audio once the full transcript exists.
  if (DEFAULT_CONFIG.audioAutoDelete) {
    try {
      await FileSystem.deleteAsync(m.audioUri, { idempotent: true });
    } catch (e) {
      log.warn('transcribe', 'audio delete failed', { err: String(e) });
    }
    await updateMeeting(id, { audioUri: null });
  }
  log.info('transcribe', 'meeting complete', { id, segments: total });
}
