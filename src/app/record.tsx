import { router } from 'expo-router';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { createMeeting, newId } from '@/data/meetings';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const { refresh } = useMeetings();

  const startedAtRef = useRef<number>(Date.now());
  const startingRef = useRef(false);
  const savingRef = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Start recording once, on mount.
  useEffect(() => {
    (async () => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setError('Microphone permission is needed to record. Enable it in Settings and try again.');
          log.warn('record', 'mic permission denied');
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        startedAtRef.current = Date.now();
        log.info('record', 'started');
      } catch (e) {
        setError('Could not start recording.');
        log.error('record', 'start failed', { err: String(e) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Smooth on-screen timer.
  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(t);
  }, []);

  const stopAndSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const durationMs = recorderState.durationMillis || Date.now() - startedAtRef.current;
      await recorder.stop();
      const uri = recorder.uri ?? null;
      const id = newId();
      await createMeeting({
        id,
        title: `Meeting · ${formatTime(startedAtRef.current)}`,
        startedAt: startedAtRef.current,
        durationMs,
        audioUri: uri,
        status: 'recorded',
      });
      await refresh();
      log.info('record', 'saved', { id, durationMs, hasAudio: !!uri });
      router.replace(`/meeting/${id}`);
    } catch (e) {
      setError('Could not save the recording.');
      log.error('record', 'stop failed', { err: String(e) });
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    try {
      if (recorderState.isRecording) await recorder.stop();
    } catch (e) {
      log.warn('record', 'cancel stop error', { err: String(e) });
    }
    log.info('record', 'cancelled');
    router.back();
  };

  if (error) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <AppText variant="heading" style={styles.center}>Recording problem</AppText>
        <AppText variant="body" muted style={styles.center}>{error}</AppText>
        <PrimaryButton label="Back" onPress={() => router.back()} style={{ marginTop: space.xl }} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.status}>
        <View style={[styles.dot, { backgroundColor: theme.rec }]} />
        <AppText variant="label" color={theme.rec}>
          {recorderState.isRecording ? 'RECORDING' : 'STARTING…'}
        </AppText>
      </View>

      <AppText variant="display" style={styles.timer}>
        {formatDuration(elapsed)}
      </AppText>
      <AppText variant="body" muted style={styles.center}>
        Recording from the phone microphone
      </AppText>

      <View style={styles.controls}>
        <Pressable onPress={cancel} style={styles.cancel}>
          <AppText variant="body" muted>Cancel</AppText>
        </Pressable>
        <PrimaryButton
          label="Stop & Save"
          onPress={stopAndSave}
          style={{ backgroundColor: theme.rec, flex: 1 }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  status: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: 64, lineHeight: 70, fontVariant: ['tabular-nums'] },
  center: { textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xxxl, alignSelf: 'stretch' },
  cancel: { paddingVertical: space.md, paddingHorizontal: space.lg },
});
