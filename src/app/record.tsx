import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  DEFAULT_LANGUAGE,
  requestSpeechPermissions,
  startSession,
  stopSession,
  supportsOnDevice,
} from '@/core/transcription/nativeSpeech';
import { createMeeting, newId, updateMeeting } from '@/data/meetings';
import { getLanguage } from '@/data/settings';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { recordingDir } from '@/hardware/recording/paths';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

/** Save the transcript to disk at most this often while recording. */
const SAVE_EVERY_MS = 5000;
/** If no recogniser event arrives for this long, assume a silent stall and restart. */
const STALL_MS = 30000;
/** Wait before restarting a session so the recogniser isn't still busy. */
const RESTART_DELAY_MS = 400;
const RESTART_DELAY_BUSY_MS = 1500;

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { refresh } = useMeetings();

  const idRef = useRef<string>(newId());
  const dirRef = useRef<string>('');
  const langRef = useRef<string>(DEFAULT_LANGUAGE);
  const onDeviceRef = useRef(true);
  const startedAtRef = useRef<number>(Date.now());

  const activeRef = useRef(false); // should we keep recognising?
  const sessionRef = useRef(0); // audio file index
  const finalRef = useRef(''); // confirmed text
  const audioUris = useRef<string[]>([]);
  const lastEventRef = useRef(Date.now());
  const lastSaveRef = useRef(0);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const startingRef = useRef(false);
  const busyRef = useRef(false);

  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Persist what we have so a crash or kill can never lose the meeting. */
  const persist = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastSaveRef.current < SAVE_EVERY_MS) return;
    lastSaveRef.current = now;
    try {
      await updateMeeting(idRef.current, {
        transcript: finalRef.current,
        durationMs: now - startedAtRef.current,
        segmentCount: audioUris.current.length,
        language: langRef.current,
      });
    } catch (e) {
      log.warn('record', 'persist failed', { err: String(e) });
    }
  };

  const scheduleRestart = (delay: number) => {
    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = setTimeout(() => {
      if (!activeRef.current) return;
      sessionRef.current += 1;
      try {
        startSession({
          dir: dirRef.current,
          index: sessionRef.current,
          lang: langRef.current,
          onDevice: onDeviceRef.current,
        });
        lastEventRef.current = Date.now();
        log.info('record', 'session restarted', { index: sessionRef.current });
      } catch (e) {
        log.error('record', 'restart failed', { err: String(e) });
        setError('Recording stopped unexpectedly. Your text so far is saved.');
        activeRef.current = false;
      }
    }, delay);
  };

  // --- live results ---
  useSpeechRecognitionEvent('result', (e) => {
    lastEventRef.current = Date.now();
    const text = e.results?.[0]?.transcript ?? '';
    if (!text) return;
    if (e.isFinal) {
      // Android continuous mode is segmented: each final is a NEW piece.
      finalRef.current = (finalRef.current + (finalRef.current ? ' ' : '') + text).trim();
      setFinalText(finalRef.current);
      setInterim('');
      persist();
    } else {
      setInterim(text);
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    lastEventRef.current = Date.now();
    busyRef.current = e.error === 'busy';
    // no-speech during a pause is normal — the session ends and we restart.
    const benign = e.error === 'no-speech' || e.error === 'speech-timeout' || e.error === 'busy';
    log[benign ? 'info' : 'warn']('record', 'recognition error', { code: e.error, msg: e.message });
  });

  // Any error or natural stop tears the session down; restart to stay continuous.
  useSpeechRecognitionEvent('end', () => {
    lastEventRef.current = Date.now();
    setListening(false);
    if (!activeRef.current) return;
    scheduleRestart(busyRef.current ? RESTART_DELAY_BUSY_MS : RESTART_DELAY_MS);
    busyRef.current = false;
  });

  useSpeechRecognitionEvent('start', () => {
    lastEventRef.current = Date.now();
    setListening(true);
  });

  // Each session writes its own audio file; record the real path it reports.
  useSpeechRecognitionEvent('audioend', (e) => {
    if (e?.uri) {
      audioUris.current.push(e.uri);
      log.info('record', 'audio segment saved', { count: audioUris.current.length });
    }
  });

  // --- start ---
  useEffect(() => {
    (async () => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const granted = await requestSpeechPermissions();
        if (!granted) {
          setError('Microphone permission is needed. Enable it in Settings and try again.');
          return;
        }
        const dir = recordingDir(idRef.current);
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        dirRef.current = dir;
        langRef.current = await getLanguage();
        onDeviceRef.current = supportsOnDevice();
        startedAtRef.current = Date.now();

        // Create the row up-front so the meeting exists even if we crash later.
        await createMeeting({
          id: idRef.current,
          title: `Meeting · ${formatTime(startedAtRef.current)}`,
          startedAt: startedAtRef.current,
          durationMs: 0,
          audioUri: dir,
          segmentCount: 0,
          status: 'recording',
        });

        activeRef.current = true;
        await activateKeepAwakeAsync('maina-recording').catch(() => {});
        startSession({ dir, index: 0, lang: langRef.current, onDevice: onDeviceRef.current });
        log.info('record', 'started', { id: idRef.current, lang: langRef.current, onDevice: onDeviceRef.current });
      } catch (e) {
        setError('Could not start recording.');
        log.error('record', 'start failed', { err: String(e) });
      }
    })();
    return () => {
      activeRef.current = false;
      if (restartTimer.current) clearTimeout(restartTimer.current);
      deactivateKeepAwake('maina-recording').catch(() => {});
    };
  }, []);

  // Timer + stall watchdog (covers silent failures, e.g. an incoming call).
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
      if (activeRef.current && Date.now() - lastEventRef.current > STALL_MS) {
        log.warn('record', 'stalled — forcing restart');
        lastEventRef.current = Date.now();
        stopSession();
        scheduleRestart(RESTART_DELAY_BUSY_MS);
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Save whenever the app is backgrounded.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') persist(true);
    });
    return () => sub.remove();
  }, []);

  const stopAndSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    activeRef.current = false;
    if (restartTimer.current) clearTimeout(restartTimer.current);
    stopSession();
    await new Promise((r) => setTimeout(r, 700)); // let the last final land
    deactivateKeepAwake('maina-recording').catch(() => {});

    const transcript = (finalRef.current + (interim ? ' ' + interim : '')).trim();
    finalRef.current = transcript;
    const id = idRef.current;
    try {
      await persist(true);
      await updateMeeting(id, { status: transcript ? 'transcribed' : 'recorded' });
      await refresh();
      log.info('record', 'saved', {
        id,
        durationMs: Date.now() - startedAtRef.current,
        chars: transcript.length,
        sessions: sessionRef.current + 1,
      });
      router.replace(`/meeting/${id}`);
    } catch (e) {
      setError('Could not save the recording.');
      log.error('record', 'save failed', { err: String(e) });
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    activeRef.current = false;
    if (restartTimer.current) clearTimeout(restartTimer.current);
    stopSession();
    deactivateKeepAwake('maina-recording').catch(() => {});
    const { deleteMeeting } = await import('@/data/meetings');
    await deleteMeeting(idRef.current).catch(() => {});
    if (dirRef.current) await FileSystem.deleteAsync(dirRef.current, { idempotent: true }).catch(() => {});
    await refresh();
    log.info('record', 'cancelled');
    router.back();
  };

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>Recording problem</AppText>
        <AppText variant="body" muted style={styles.center}>{error}</AppText>
        <PrimaryButton label="Save what we have" onPress={stopAndSave} style={{ marginTop: space.lg }} />
        <Pressable onPress={cancel} style={{ marginTop: space.lg }}>
          <AppText variant="body" muted>Discard</AppText>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <View style={styles.status}>
          <View style={[styles.dot, { backgroundColor: listening ? theme.rec : theme.muted }]} />
          <AppText variant="label" color={listening ? theme.rec : theme.muted}>
            {listening ? 'LISTENING' : 'RECONNECTING…'}
          </AppText>
        </View>
        <AppText variant="display" style={styles.timer}>{formatDuration(elapsed)}</AppText>
      </View>

      <ScrollView style={styles.transcriptBox} contentContainerStyle={{ padding: space.lg }}>
        {finalText || interim ? (
          <AppText variant="body">
            {finalText}
            {interim ? <AppText variant="body" muted>{(finalText ? ' ' : '') + interim}</AppText> : null}
          </AppText>
        ) : (
          <AppText variant="body" muted style={styles.center}>
            Start speaking — your words appear here live.
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
  header: { alignItems: 'center', gap: space.sm, paddingVertical: space.lg },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: 56, lineHeight: 62, fontVariant: ['tabular-nums'] },
  transcriptBox: { flex: 1, marginHorizontal: space.lg },
  center: { textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  cancel: { paddingVertical: space.md, paddingHorizontal: space.lg },
});
