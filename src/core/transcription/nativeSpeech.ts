/**
 * Primary transcription engine: the phone's own speech recognition
 * (Android SpeechRecognizer via expo-speech-recognition).
 *
 * Why: it streams text live as you speak and is the fastest zero-cost path on
 * the Pixel. Android does not guarantee the hardware used, hours-long uptime,
 * or code-switch quality, so the durable audio remains the source of truth.
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
export function startSession(opts: { dir: string; index: number; lang: string }): void {
  ExpoSpeechRecognitionModule.start({
    lang: opts.lang,
    interimResults: true,
    continuous: true,
    requiresOnDeviceRecognition: true,
    addsPunctuation: true,
    androidRecognitionServicePackage: ON_DEVICE_SERVICE,
    androidIntentOptions: {
      // Lets the recognizer switch between Hindi and English mid-speech (Hinglish).
      EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced',
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: ['hi-IN', 'en-IN', 'en-US'],
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: ['hi-IN', 'en-IN', 'en-US'],
      EXTRA_MASK_OFFENSIVE_WORDS: false,
    },
    recordingOptions: {
      persist: true,
      outputDirectory: opts.dir,
      outputFileName: segmentName(opts.index),
    },
    volumeChangeEventOptions: {
      enabled: true,
      intervalMillis: 1000,
    },
  });
}

/**
 * Re-transcribe a previously saved audio file with the same engine.
 * This is the safety net that replaces Whisper: if live capture produced
 * nothing (or the wrong language was selected), re-read the saved WAV.
 */
export function startFileSession(opts: { uri: string; lang: string }): void {
  ExpoSpeechRecognitionModule.start({
    lang: opts.lang,
    interimResults: false,
    continuous: true,
    requiresOnDeviceRecognition: true,
    androidRecognitionServicePackage: ON_DEVICE_SERVICE,
    addsPunctuation: true,
    androidIntentOptions: {
      EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced',
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: ['hi-IN', 'en-IN', 'en-US'],
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: ['hi-IN', 'en-IN', 'en-US'],
    },
    audioSource: {
      uri: opts.uri,
      audioChannels: 1,
      sampleRate: 16000,
      // On-device recognition needs a slower feed to keep up.
      chunkDelayMillis: 25,
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
