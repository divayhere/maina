/**
 * Recording (hardware isolation): captures 16 kHz mono 16-bit PCM and writes a
 * WAV file — exactly what whisper.rn needs, with no transcoding. Android's
 * default recorder can only make AAC/m4a (which whisper can't read), so we use
 * a raw-PCM capture that writes WAV directly.
 */
import AudioRecord from '@fugood/react-native-audio-pcm-stream';

import { log } from '../../services/logger';

/** Android audio source 6 = VOICE_RECOGNITION (tuned for speech, applies NS/AEC). */
const VOICE_RECOGNITION = 6;

export function startPcmRecording(wavFileName: string): void {
  AudioRecord.init({
    sampleRate: 16000,
    channels: 1,
    bitsPerSample: 16,
    audioSource: VOICE_RECOGNITION,
    wavFile: wavFileName,
    bufferSize: 4096,
  });
  AudioRecord.start();
  log.info('recorder', 'pcm started', { wavFileName });
}

/** Stops and returns the written WAV file path. */
export async function stopPcmRecording(): Promise<string> {
  const path = await AudioRecord.stop();
  log.info('recorder', 'pcm stopped', { path });
  return path;
}
