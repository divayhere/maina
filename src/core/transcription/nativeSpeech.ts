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
import { selectRecognitionLanguage } from './languageSelection';

export { selectRecognitionLanguage } from './languageSelection';

export const LANGUAGES = [
  { code: 'en-IN', label: 'Indian English' },
  { code: 'hi-IN', label: 'Hindi' },
] as const;

export const DEFAULT_LANGUAGE = 'en-IN';
export const ACTIVE_LANGUAGES = LANGUAGES.map((language) => language.code);

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

export interface LanguageProvisioningState {
  ready: boolean;
  installed: string[];
  pending: string[];
  unsupported: string[];
}

const sameLocale = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** Provision English + Hindi without presenting a language picker. */
export async function provisionCoreLanguages(): Promise<LanguageProvisioningState> {
  let locales = await getOfflineLocales();
  const unsupported: string[] = [];
  const pending: string[] = [];
  for (const locale of ACTIVE_LANGUAGES) {
    if (locales.installed.some((item) => sameLocale(item, locale))) continue;
    if (locales.supported.length > 0 && !locales.supported.some((item) => sameLocale(item, locale))) {
      unsupported.push(locale);
      continue;
    }
    try {
      const status = await downloadOfflineLanguage(locale);
      if (status !== 'download_success') pending.push(locale);
      locales = await getOfflineLocales();
    } catch (cause) {
      pending.push(locale);
      log.warn('native-speech', 'automatic model provisioning failed', { locale, err: String(cause) });
    }
  }
  const installed = locales.installed;
  const missing = ACTIVE_LANGUAGES.filter(
    (locale) => !installed.some((item) => sameLocale(item, locale)) && !unsupported.includes(locale),
  );
  const state = {
    ready: unsupported.length === 0 && missing.length === 0,
    installed,
    pending: [...new Set([...pending, ...missing])],
    unsupported,
  };
  log.info('native-speech', 'core language provisioning checked', {
    ready: state.ready,
    activeLanguages: ACTIVE_LANGUAGES,
    installed,
    pending: state.pending,
    unsupported,
  });
  return state;
}

/** Never block recording for a missing preferred pack: use the best installed fallback. */
export async function chooseRecognitionLanguage(): Promise<string> {
  const { installed } = await getOfflineLocales();
  const selected = selectRecognitionLanguage(installed);
  if (selected) return selected;
  log.warn('native-speech', 'no offline model reported; recorder will attempt default while provisioning continues', {
    defaultLanguage: DEFAULT_LANGUAGE,
  });
  return DEFAULT_LANGUAGE;
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
      EXTRA_ENABLE_LANGUAGE_SWITCH: 'high_precision',
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: ACTIVE_LANGUAGES,
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: ACTIVE_LANGUAGES,
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
      EXTRA_ENABLE_LANGUAGE_SWITCH: 'high_precision',
      EXTRA_ENABLE_LANGUAGE_DETECTION: true,
      EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES: ACTIVE_LANGUAGES,
      EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES: ACTIVE_LANGUAGES,
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
