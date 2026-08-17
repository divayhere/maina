import { requireOptionalNativeModule } from 'expo';

export interface AudioInput {
  id: number;
  name: string;
  type: string;
}

interface MainaRecorderNativeModule {
  startForegroundSession(): Promise<boolean>;
  stopForegroundSession(): Promise<void>;
  isForegroundSessionRunning(): boolean;
  repairWavFiles(uris: string[]): Promise<number>;
  getAudioInputs(): Promise<AudioInput[]>;
}

export const MainaRecorder =
  requireOptionalNativeModule<MainaRecorderNativeModule>('MainaRecorder');
