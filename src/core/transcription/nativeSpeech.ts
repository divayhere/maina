/**
 * Primary transcription engine: the phone's own speech recognition
 * (Android SpeechRecognizer via expo-speech-recognition).
 *
 * Why: it streams text live as you speak, runs on the device's dedicated
 * speech hardware, is free forever, works offline, and handles Hindi/English
 * code-switching natively. Whisper on the CPU could never be real-time.
 *
 * Audio is persisted alongside so a Whisper re-pass stays possible.
 */
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

import { segmentName } from '../../hardware/recording/paths';
import { log } from '../../services/logger';

export const LANGUAGES = [
  { code: 'hi-IN', label: 'Hindi (India)', hint: 'best for Hindi + Hinglish' },
  { code: 'en-IN', label: 'English (India)', hint: 'best for English-dominant' },
  { code: 'en-US', label: 'English (US)', hint: '' },
] as const;

export const DEFAULT_LANGUAGE = 'hi-IN';

/** Google's on-device recognition service — the one with offline language packs. */
export const ON_DEVICE_SERVICE = 'com.google.android.as';

export async function requestSpeechPermissions(): Promise<boolean> {
  const res = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return res.granted;
}

export function supportsOnDevice(): boolean {
  try {
    return ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
  } catch {
    return false;
  }
}

/** Which locales are installed for offline use. */
export async function getOfflineLocales(): Promise<{ installed: string[]; supported: string[] }> {
  try {
    const res = await ExpoSpeechRecognitionModule.getSupportedLocales({
      androidRecognitionServicePackage: ON_DEVICE_SERVICE,
    });
    return { installed: res.installedLocales ?? [], supported: res.locales ?? [] };
  } catch (e) {
    log.warn('native-speech', 'getSupportedLocales failed', { err: String(e) });
    return { installed: [], supported: [] };
  }
}

/** Ask Android to download the offline language pack (one-time, per language). */
export async function downloadOfflineLanguage(locale: string): Promise<string> {
  const res = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale });
  log.info('native-speech', 'offline model download', { locale, status: res.status });
  return res.status;
}

/**
 * Start a recognition session. Android may end a session on its own (long
 * silence, internal limits), so the caller restarts with the next index —
 * each session writes its own audio file into the meeting's folder.
 */
export function startSession(opts: { dir: string; index: number; lang: string; onDevice: boolean }): void {
  ExpoSpeechRecognitionModule.start({
    lang: opts.lang,
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: opts.onDevice,
    addsPunctuation: true,
    ...(opts.onDevice ? { androidRecognitionServicePackage: ON_DEVICE_SERVICE } : {}),
    androidIntentOptions: {
      // Lets the recognizer switch between Hindi and English mid-speech (Hinglish).
      EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced',
      EXTRA_MASK_OFFENSIVE_WORDS: false,
    },
    recordingOptions: {
      persist: true,
      outputDirectory: opts.dir,
      outputFileName: segmentName(opts.index),
    },
  });
}

export function stopSession(): void {
  try {
    ExpoSpeechRecognitionModule.stop();
  } catch (e) {
    log.warn('native-speech', 'stop failed', { err: String(e) });
  }
}

export function abortSession(): void {
  try {
    ExpoSpeechRecognitionModule.abort();
  } catch {
    /* ignore */
  }
}
