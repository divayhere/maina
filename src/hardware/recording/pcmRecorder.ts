/**
 * Recording (hardware isolation) — the reliable source of truth.
 *
 * The native PCM library only STREAMS raw 16-bit PCM chunks; we write them to
 * disk as a sequence of ~30-second WAV segment files. Only the current segment
 * is held in memory (≈1 MB), so hours-long recordings never fill RAM. Segments
 * double as natural chunks for resumable transcription. Recording never depends
 * on transcription keeping up.
 */
import AudioRecord from '@fugood/react-native-audio-pcm-stream';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';

import { log } from '../../services/logger';
import { recordingDir, segmentPath } from './paths';

export { recordingDir, segmentPath };

const VOICE_RECOGNITION = 6; // Android AudioSource tuned for speech
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;
const SEGMENT_BYTES = SAMPLE_RATE * (BITS / 8) * CHANNELS * 30; // 30 seconds

let dir = '';
let buf: Buffer[] = [];
let bufBytes = 0;
let segIndex = 0;
let sub: { remove: () => void } | null = null;
let writeChain: Promise<void> = Promise.resolve();

export async function startSegmentedRecording(meetingId: string): Promise<string> {
  dir = recordingDir(meetingId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  buf = [];
  bufBytes = 0;
  segIndex = 0;
  writeChain = Promise.resolve();

  AudioRecord.init({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitsPerSample: BITS,
    audioSource: VOICE_RECOGNITION,
    wavFile: 'unused.wav', // key required but ignored on Android
    bufferSize: 4096,
  });
  sub = AudioRecord.on('data', (b64: string) => {
    const b = Buffer.from(b64, 'base64');
    buf.push(b);
    bufBytes += b.length;
    if (bufBytes >= SEGMENT_BYTES) flushSegment();
  });
  AudioRecord.start();
  log.info('recorder', 'segmented start', { dir });
  return dir;
}

function flushSegment(): void {
  if (bufBytes === 0) return;
  const pcm = Buffer.concat(buf);
  const idx = segIndex++;
  buf = [];
  bufBytes = 0;
  const path = segmentPath(dir, idx);
  const wav = buildWav(pcm);
  // Serialize writes so segments land in order and don't overlap.
  writeChain = writeChain
    .then(() =>
      FileSystem.writeAsStringAsync(path, wav.toString('base64'), {
        encoding: FileSystem.EncodingType.Base64,
      }),
    )
    .then(() => log.info('recorder', 'segment written', { idx, bytes: wav.length }))
    .catch((e) => log.error('recorder', 'segment write failed', { idx, err: String(e) }));
}

export async function stopSegmentedRecording(): Promise<{ dir: string; segmentCount: number }> {
  AudioRecord.stop();
  // Let the recording thread flush its last buffers.
  await new Promise((r) => setTimeout(r, 300));
  sub?.remove();
  sub = null;
  flushSegment(); // final partial segment
  await writeChain; // ensure every segment is on disk
  const segmentCount = segIndex;
  log.info('recorder', 'segmented stop', { dir, segmentCount });
  return { dir, segmentCount };
}

/** Prepend a 44-byte PCM WAV header to raw PCM bytes. */
function buildWav(pcm: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS) / 8;
  const blockAlign = (CHANNELS * BITS) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
