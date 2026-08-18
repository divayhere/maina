import { Platform } from 'react-native';

import {
  MainaRecorder,
  type AudioInput,
  type AudioRouteChangedEvent,
} from '../../../modules/maina-recorder/src';

function requireAndroidModule() {
  if (Platform.OS !== 'android' || !MainaRecorder) {
    throw new Error('MainaRecorder native module is unavailable');
  }
  return MainaRecorder;
}

export async function startRecordingForegroundService(): Promise<void> {
  const started = await requireAndroidModule().startForegroundSession();
  if (!started) throw new Error('Android did not start the recording service');
}

export async function stopRecordingForegroundService(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) {
    await MainaRecorder.stopForegroundSession();
  }
}

export function isRecordingForegroundServiceRunning(): boolean {
  return Platform.OS === 'android' && !!MainaRecorder?.isForegroundSessionRunning();
}

export async function repairWavFiles(uris: string[]): Promise<number> {
  if (Platform.OS !== 'android' || !MainaRecorder || uris.length === 0) return 0;
  return MainaRecorder.repairWavFiles(uris);
}

export async function getPcmWavDurationsMs(uris: string[]): Promise<Record<string, number | null>> {
  if (Platform.OS !== 'android' || !MainaRecorder || uris.length === 0) return {};
  return MainaRecorder.getPcmWavDurationsMs(uris);
}

export async function listAudioInputs(): Promise<AudioInput[]> {
  if (Platform.OS !== 'android' || !MainaRecorder) return [];
  return MainaRecorder.getAudioInputs();
}

export function subscribeAudioRouteChanges(
  listener: (event: AudioRouteChangedEvent) => void,
): () => void {
  if (Platform.OS !== 'android' || !MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onAudioRouteChanged', listener);
  return () => subscription.remove();
}
