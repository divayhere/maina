/**
 * Recording (hardware isolation): the native PCM library only STREAMS raw
 * 16-bit PCM chunks (it does not write a file), so we collect the chunks and
 * assemble a 16 kHz mono WAV ourselves — exactly what whisper.rn needs.
 *
 * Note: chunks are held in memory during a recording (16 kHz mono ≈ 2 KB/s of
 * PCM). Fine for typical meetings; streaming-to-disk is a later hardening step.
 */
import AudioRecord from '@fugood/react-native-audio-pcm-stream';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';

import { log } from '../../services/logger';

/** Android audio source 6 = VOICE_RECOGNITION (tuned for speech). */
const VOICE_RECOGNITION = 6;
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS = 16;

let chunks: Buffer[] = [];
let subscription: { remove: () => void } | null = null;

export function startPcmRecording(): void {
  chunks = [];
  AudioRecord.init({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitsPerSample: BITS,
    audioSource: VOICE_RECOGNITION,
    wavFile: 'unused.wav', // library requires the key but ignores it on Android
    bufferSize: 4096,
  });
  subscription = AudioRecord.on('data', (b64: string) => {
    chunks.push(Buffer.from(b64, 'base64'));
  });
  AudioRecord.start();
  log.info('recorder', 'pcm started', { sampleRate: SAMPLE_RATE });
}

/** Stops, assembles a WAV file, and returns its path (empty string if silent). */
export async function stopPcmRecording(): Promise<string> {
  AudioRecord.stop();
  // Let the recording thread flush its last buffers.
  await new Promise((r) => setTimeout(r, 300));
  subscription?.remove();
  subscription = null;

  const pcm = Buffer.concat(chunks);
  const chunkCount = chunks.length;
  chunks = [];

  if (pcm.length === 0) {
    log.warn('recorder', 'no audio captured (0 bytes)', { chunkCount });
    return '';
  }

  const wav = buildWav(pcm);
  const path = `${FileSystem.documentDirectory}maina-${Date.now().toString(36)}.wav`;
  await FileSystem.writeAsStringAsync(path, wav.toString('base64'), {
    encoding: FileSystem.EncodingType.Base64,
  });
  log.info('recorder', 'wav written', { path, bytes: wav.length, pcmBytes: pcm.length, chunkCount });
  return path;
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
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
