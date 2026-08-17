import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  DEFAULT_LANGUAGE,
  abortSession,
  getOfflineLocales,
  requestSpeechPermissions,
  startSession,
  stopSession,
  supportsOnDevice,
} from '@/core/transcription/nativeSpeech';
import { mergeTranscript, transcriptWordCount } from '@/core/transcription/transcript';
import {
  createMeeting,
  deleteMeeting,
  finishRecordingSegment,
  newId,
  startRecordingSegment,
  updateMeeting,
} from '@/data/meetings';
import { getLanguage } from '@/data/settings';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import {
  listAudioInputs,
  startRecordingForegroundService,
  stopRecordingForegroundService,
} from '@/hardware/recording/foreground';
import { recordingDir, segmentIndexFromUri, segmentPath } from '@/hardware/recording/paths';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

const SAVE_EVERY_MS = 5000;
const STALL_MS = 45000;
const MAX_FILE_MS = 10 * 60 * 1000;
const RESTART_DELAY_MS = 500;
const RESTART_DELAY_BUSY_MS = 1600;
const END_FALLBACK_MS = 2500;
const FINAL_RESULT_TIMEOUT_MS = 6000;

interface EndWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { refresh } = useMeetings();

  const idRef = useRef(newId());
  const dirRef = useRef('');
  const langRef = useRef(DEFAULT_LANGUAGE);
  const startedAtRef = useRef(0);
  const sessionStartedAtRef = useRef(0);
  const activeRef = useRef(false);
  const meetingCreatedRef = useRef(false);
  const sessionRef = useRef(0);
  const restartCountRef = useRef(0);
  const finalRef = useRef('');
  const interimRef = useRef('');
  const lastEventRef = useRef(0);
  const lastSaveRef = useRef(0);
  const lastHealthRef = useRef(0);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endWaiterRef = useRef<EndWaiter | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const savingRef = useRef(false);
  const startingRef = useRef(false);
  const endingSessionRef = useRef(false);
  const busyRef = useRef(false);
  const sessionErrorRef = useRef<string | undefined>(undefined);

  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetingCreated, setMeetingCreated] = useState(false);

  const commitText = (text: string) => {
    if (!text.trim()) return;
    finalRef.current = mergeTranscript(finalRef.current, text);
    interimRef.current = '';
    setFinalText(finalRef.current);
    setInterim('');
  };

  const persist = (force = false): Promise<void> => {
    if (!meetingCreatedRef.current) return Promise.resolve();
    const now = Date.now();
    if (!force && now - lastSaveRef.current < SAVE_EVERY_MS) return persistChainRef.current;
    lastSaveRef.current = now;
    const snapshot = {
      transcript: finalRef.current,
      durationMs: now - startedAtRef.current,
      segmentCount: sessionRef.current + 1,
      language: langRef.current,
      restartCount: restartCountRef.current,
    };
    persistChainRef.current = persistChainRef.current
      .catch(() => {})
      .then(() => updateMeeting(idRef.current, snapshot))
      .catch((cause) => {
        log.warn('record', 'checkpoint failed', { err: String(cause) });
      });
    return persistChainRef.current;
  };

  const beginSession = async (index: number) => {
    if (index > 0) {
      await finishRecordingSegment(
        idRef.current,
        index - 1,
        segmentPath(dirRef.current, index - 1),
        sessionErrorRef.current,
      ).catch(() => {});
    }
    const expectedUri = segmentPath(dirRef.current, index);
    await startRecordingSegment(idRef.current, index, expectedUri);
    sessionRef.current = index;
    sessionStartedAtRef.current = Date.now();
    endingSessionRef.current = false;
    sessionErrorRef.current = undefined;
    await updateMeeting(idRef.current, {
      segmentCount: index + 1,
      restartCount: restartCountRef.current,
    });
    startSession({ dir: dirRef.current, index, lang: langRef.current });
  };

  const scheduleRestart = (delay: number, reason: string) => {
    if (!activeRef.current) return;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!activeRef.current) return;
      const next = sessionRef.current + 1;
      restartCountRef.current += 1;
      beginSession(next)
        .then(() => log.info('record', 'session restarted', { index: next, reason }))
        .catch(async (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          log.error('record', 'restart failed', { err: message, index: next });
          await updateMeeting(idRef.current, { lastError: message }).catch(() => {});
          setError('Recording could not restart. Your audio and transcript checkpoints were kept.');
          activeRef.current = false;
          await stopRecordingForegroundService().catch(() => {});
        });
    }, delay);
  };

  const requestSessionEnd = (reason: string, graceful: boolean) => {
    if (!activeRef.current || endingSessionRef.current) return;
    endingSessionRef.current = true;
    commitText(interimRef.current);
    lastEventRef.current = Date.now();
    log.info('record', 'ending audio file', { index: sessionRef.current, reason, graceful });
    if (graceful) stopSession();
    else abortSession();
    // Upstream has reported silent interruptions without an end event. This
    // fallback is cancelled/replaced if end arrives normally.
    scheduleRestart(END_FALLBACK_MS, `${reason}-fallback`);
  };

  useSpeechRecognitionEvent('result', (event) => {
    lastEventRef.current = Date.now();
    const text = event.results?.[0]?.transcript ?? '';
    if (!text) return;
    if (event.isFinal) {
      commitText(text);
      void persist();
    } else {
      interimRef.current = text;
      setInterim(text);
    }
  });

  useSpeechRecognitionEvent('volumechange', () => {
    lastEventRef.current = Date.now();
  });

  useSpeechRecognitionEvent('languagedetection', (event) => {
    lastEventRef.current = Date.now();
    log.debug('record', 'language detected', {
      language: event.detectedLanguage,
      confidence: event.confidence,
    });
  });

  useSpeechRecognitionEvent('error', (event) => {
    lastEventRef.current = Date.now();
    busyRef.current = event.error === 'busy';
    sessionErrorRef.current = event.error;
    const benign = event.error === 'no-speech' || event.error === 'speech-timeout' || busyRef.current;
    log[benign ? 'info' : 'warn']('record', 'recognition error', {
      code: event.error,
      nativeCode: event.code,
      message: event.message,
      index: sessionRef.current,
    });
  });

  useSpeechRecognitionEvent('end', () => {
    lastEventRef.current = Date.now();
    setListening(false);
    endingSessionRef.current = false;
    const waiter = endWaiterRef.current;
    if (waiter) {
      clearTimeout(waiter.timer);
      endWaiterRef.current = null;
      waiter.resolve();
    }
    if (!activeRef.current) return;
    scheduleRestart(busyRef.current ? RESTART_DELAY_BUSY_MS : RESTART_DELAY_MS, 'recognizer-end');
    busyRef.current = false;
  });

  useSpeechRecognitionEvent('start', () => {
    lastEventRef.current = Date.now();
    setListening(true);
    log.info('record', 'recognizer ready', { index: sessionRef.current });
  });

  useSpeechRecognitionEvent('audioend', (event) => {
    const index = segmentIndexFromUri(event?.uri) ?? sessionRef.current;
    void finishRecordingSegment(
      idRef.current,
      index,
      event?.uri ?? null,
      event?.uri ? sessionErrorRef.current : sessionErrorRef.current ?? 'missing-audio-uri',
    ).catch((cause) => log.warn('record', 'audio checkpoint metadata failed', { err: String(cause), index }));
    log.info('record', 'audio file closed', {
      index,
      saved: !!event?.uri,
      errorCode: sessionErrorRef.current,
    });
  });

  useEffect(() => {
    (async () => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const granted = await requestSpeechPermissions();
        if (!granted) throw new Error('Microphone permission was not granted.');
        if (!supportsOnDevice()) {
          throw new Error('On-device speech recognition is unavailable. Maina refused the network fallback.');
        }

        const dir = recordingDir(idRef.current);
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        dirRef.current = dir;
        langRef.current = await getLanguage();
        const locales = await getOfflineLocales();
        const installed = locales.installed.some(
          (locale) => locale.toLocaleLowerCase() === langRef.current.toLocaleLowerCase(),
        );
        log.info('record', 'offline speech check', {
          language: langRef.current,
          installed,
          installedCount: locales.installed.length,
          supportedCount: locales.supported.length,
        });
        if (locales.installed.length > 0 && !installed) {
          throw new Error(`The ${langRef.current} offline language pack is not installed. Download it in Settings.`);
        }

        startedAtRef.current = Date.now();
        await createMeeting({
          id: idRef.current,
          title: `Meeting · ${formatTime(startedAtRef.current)}`,
          startedAt: startedAtRef.current,
          durationMs: 0,
          audioUri: dir,
          segmentCount: 0,
          status: 'recording',
        });
        meetingCreatedRef.current = true;
        setMeetingCreated(true);
        await startRecordingForegroundService();
        const inputs = await listAudioInputs().catch(() => []);
        log.info('record', 'audio inputs visible', {
          inputs: inputs.map((input) => `${input.type}:${input.name}`),
        });
        activeRef.current = true;
        await beginSession(0);
        log.info('record', 'meeting capture started', {
          language: langRef.current,
          segmentMinutes: MAX_FILE_MS / 60000,
          offlineOnly: true,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        activeRef.current = false;
        await updateMeeting(idRef.current, { status: 'interrupted', lastError: message }).catch(() => {});
        await stopRecordingForegroundService().catch(() => {});
        log.error('record', 'capture start failed', { err: message });
      }
    })();

    return () => {
      activeRef.current = false;
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      void persist(true);
      abortSession();
      void stopRecordingForegroundService().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (!activeRef.current || startedAtRef.current === 0) return;
      setElapsed(now - startedAtRef.current);
      void persist();

      if (now - lastHealthRef.current >= 60000) {
        lastHealthRef.current = now;
        log.info('record-health', 'capture heartbeat', {
          elapsedMs: now - startedAtRef.current,
          words: transcriptWordCount(finalRef.current),
          index: sessionRef.current,
          restarts: restartCountRef.current,
          listening,
        });
      }
      if (now - sessionStartedAtRef.current >= MAX_FILE_MS) {
        requestSessionEnd('ten-minute-rotation', true);
      } else if (now - lastEventRef.current >= STALL_MS) {
        log.warn('record', 'recognizer heartbeat stalled', {
          silentMs: now - lastEventRef.current,
          index: sessionRef.current,
        });
        requestSessionEnd('stall-watchdog', false);
      }
    }, 1000);
    return () => clearInterval(timer);
    // The watchdog reads mutable capture refs by design; rebuilding it for
    // every helper identity would reset its timing window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      log.info('record', 'app state changed', { state });
      if (state !== 'active') void persist(true);
    });
    return () => subscription.remove();
  }, []);

  const waitForRecognizerEnd = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        endWaiterRef.current = null;
        log.warn('record', 'final result timeout', { index: sessionRef.current });
        abortSession();
        resolve();
      }, FINAL_RESULT_TIMEOUT_MS);
      endWaiterRef.current = { resolve, timer };
    });

  const stopAndSave = async () => {
    if (savingRef.current || !meetingCreatedRef.current) return;
    savingRef.current = true;
    activeRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    commitText(interimRef.current);
    const endPromise = waitForRecognizerEnd();
    stopSession();
    await endPromise;
    await stopRecordingForegroundService().catch((cause) => {
      log.warn('record', 'foreground service stop failed', { err: String(cause) });
    });

    const id = idRef.current;
    try {
      await persist(true);
      await updateMeeting(id, {
        transcript: finalRef.current,
        status: finalRef.current ? 'transcribed' : 'recorded',
        lastError: null,
      });
      await refresh();
      log.info('record', 'meeting saved', {
        durationMs: Date.now() - startedAtRef.current,
        words: transcriptWordCount(finalRef.current),
        files: sessionRef.current + 1,
        restarts: restartCountRef.current,
      });
      router.replace(`/meeting/${id}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError('Maina could not finish the database checkpoint. Your WAV files remain on the phone.');
      log.error('record', 'meeting save failed', { err: message });
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    activeRef.current = false;
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    abortSession();
    await stopRecordingForegroundService().catch(() => {});
    if (meetingCreatedRef.current) await deleteMeeting(idRef.current).catch(() => {});
    if (dirRef.current) await FileSystem.deleteAsync(dirRef.current, { idempotent: true }).catch(() => {});
    await refresh();
    log.info('record', 'meeting discarded');
    router.back();
  };

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>Recording problem</AppText>
        <AppText variant="body" muted style={styles.center}>{error}</AppText>
        {meetingCreated ? (
          <PrimaryButton label="Save what Maina kept" onPress={stopAndSave} style={{ marginTop: space.lg }} />
        ) : (
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ marginTop: space.lg }} />
        )}
        {meetingCreated ? (
          <Pressable onPress={cancel} style={{ marginTop: space.lg }}>
            <AppText variant="body" muted>Discard</AppText>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: listening ? theme.rec : theme.warn }]} />
          <AppText variant="label" color={listening ? theme.rec : theme.warn}>
            {listening ? 'RECORDING · OFFLINE' : 'RECOVERING SPEECH…'}
          </AppText>
        </View>
        <AppText variant="display" style={styles.timer}>{formatDuration(elapsed)}</AppText>
        <AppText variant="label" muted>Background service active · audio checkpoints every 10 minutes</AppText>
      </View>

      <ScrollView style={styles.transcriptBox} contentContainerStyle={{ padding: space.lg }}>
        {finalText || interim ? (
          <AppText variant="body">
            {finalText}
            {interim ? <AppText variant="body" muted>{(finalText ? ' ' : '') + interim}</AppText> : null}
          </AppText>
        ) : (
          <AppText variant="body" muted style={styles.center}>
            Maina is keeping the audio. Live words appear here when the on-device recognizer is confident.
          </AppText>
        )}
      </ScrollView>

      <View style={styles.controls}>
        <Pressable onPress={cancel} style={styles.cancel}>
          <AppText variant="body" muted>Discard</AppText>
        </Pressable>
        <PrimaryButton label="Stop & Save" onPress={stopAndSave} style={{ backgroundColor: theme.rec, flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: space.xxxl },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  header: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.lg },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: 56, lineHeight: 62, fontVariant: ['tabular-nums'] },
  transcriptBox: { flex: 1, marginHorizontal: space.lg },
  center: { textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  cancel: { paddingVertical: space.md, paddingHorizontal: space.lg },
});
