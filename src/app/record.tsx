import * as FileSystem from 'expo-file-system/legacy';
import { router } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  DEFAULT_LANGUAGE,
  requestSpeechPermissions,
  startSession,
  stopSession,
  supportsOnDevice,
} from '@/core/transcription/nativeSpeech';
import { createMeeting, newId } from '@/data/meetings';
import { getLanguage } from '@/data/settings';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { recordingDir } from '@/hardware/recording/paths';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { refresh } = useMeetings();

  const idRef = useRef<string>(newId());
  const dirRef = useRef<string>('');
  const langRef = useRef<string>(DEFAULT_LANGUAGE);
  const onDeviceRef = useRef<boolean>(true);
  const startedAtRef = useRef<number>(Date.now());
  const activeRef = useRef(false); // should we keep recognising?
  const sessionRef = useRef(0); // audio file index
  const finalRef = useRef(''); // confirmed text so far
  const savingRef = useRef(false);
  const startingRef = useRef(false);
  const errorCountRef = useRef(0);

  const [finalText, setFinalText] = useState('');
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- live results ---
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results?.[0]?.transcript ?? '';
    if (!text) return;
    if (e.isFinal) {
      finalRef.current = (finalRef.current + (finalRef.current ? ' ' : '') + text).trim();
      setFinalText(finalRef.current);
      setInterim('');
    } else {
      setInterim(text);
    }
  });

  useSpeechRecognitionEvent('error', (e) => {
    // "no-speech" / "no match" during a pause is normal — the end handler restarts us.
    const benign = e.error === 'no-speech' || e.error === 'speech-timeout';
    log[benign ? 'info' : 'warn']('record', 'recognition error', { code: e.error, msg: e.message });
    if (!benign) {
      errorCountRef.current += 1;
      if (errorCountRef.current >= 5 && activeRef.current) {
        activeRef.current = false;
        setError(`Speech recognition stopped: ${e.message || e.error}`);
      }
    }
  });

  // Android ends sessions on its own; restart to keep one continuous recording.
  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    if (!activeRef.current) return;
    sessionRef.current += 1;
    try {
      startSession({
        dir: dirRef.current,
        index: sessionRef.current,
        lang: langRef.current,
        onDevice: onDeviceRef.current,
      });
      setListening(true);
      log.info('record', 'session restarted', { index: sessionRef.current });
    } catch (e) {
      log.error('record', 'restart failed', { err: String(e) });
      setError('Recording stopped unexpectedly. Your text so far is saved.');
      activeRef.current = false;
    }
  });

  useSpeechRecognitionEvent('start', () => setListening(true));

  // --- start on mount ---
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
        activeRef.current = true;
        startedAtRef.current = Date.now();
        startSession({ dir, index: 0, lang: langRef.current, onDevice: onDeviceRef.current });
        log.info('record', 'started', { lang: langRef.current, onDevice: onDeviceRef.current });
      } catch (e) {
        setError('Could not start recording.');
        log.error('record', 'start failed', { err: String(e) });
      }
    })();
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(t);
  }, []);

  const stopAndSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    activeRef.current = false;
    stopSession();
    // let the last final result land
    await new Promise((r) => setTimeout(r, 600));

    const durationMs = Date.now() - startedAtRef.current;
    const transcript = (finalRef.current + (interim ? ' ' + interim : '')).trim();
    const id = idRef.current;
    try {
      await createMeeting({
        id,
        title: `Meeting · ${formatTime(startedAtRef.current)}`,
        startedAt: startedAtRef.current,
        durationMs,
        audioUri: dirRef.current,
        segmentCount: sessionRef.current + 1,
        status: transcript ? 'transcribed' : 'recorded',
      });
      if (transcript) {
        const { updateMeeting } = await import('@/data/meetings');
        await updateMeeting(id, {
          transcript,
          language: langRef.current,
          transcribedSegments: sessionRef.current + 1,
        });
      }
      await refresh();
      log.info('record', 'saved', { id, durationMs, chars: transcript.length, sessions: sessionRef.current + 1 });
      router.replace(`/meeting/${id}`);
    } catch (e) {
      setError('Could not save the recording.');
      log.error('record', 'save failed', { err: String(e) });
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    activeRef.current = false;
    stopSession();
    if (dirRef.current) await FileSystem.deleteAsync(dirRef.current, { idempotent: true }).catch(() => {});
    log.info('record', 'cancelled');
    router.back();
  };

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>Recording problem</AppText>
        <AppText variant="body" muted style={styles.center}>{error}</AppText>
        {finalText ? <PrimaryButton label="Save what we have" onPress={stopAndSave} style={{ marginTop: space.lg }} /> : null}
        <Pressable onPress={() => router.back()} style={{ marginTop: space.lg }}>
          <AppText variant="body" muted>Back</AppText>
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
            {listening ? 'LISTENING' : 'STARTING…'}
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
          <AppText variant="body" muted>Cancel</AppText>
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
