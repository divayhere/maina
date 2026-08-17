import { requestRecordingPermissionsAsync } from 'expo-audio';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { createMeeting, newId } from '@/data/meetings';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { startPcmRecording, stopPcmRecording } from '@/hardware/recording/pcmRecorder';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDuration, formatTime } from '@/utils/format';

export default function RecordScreen() {
  const { theme } = useAppTheme();
  const { refresh } = useMeetings();

  const idRef = useRef<string>(newId());
  const startedAtRef = useRef<number>(Date.now());
  const startingRef = useRef(false);
  const savingRef = useRef(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
        startPcmRecording(`maina-${idRef.current}.wav`);
        startedAtRef.current = Date.now();
        setRecording(true);
      } catch (e) {
        setError('Could not start recording.');
        log.error('record', 'start failed', { err: String(e) });
      }
    })();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 250);
    return () => clearInterval(t);
  }, []);

  const stopAndSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      const durationMs = Date.now() - startedAtRef.current;
      const path = await stopPcmRecording();
      setRecording(false);
      const id = idRef.current;
      await createMeeting({
        id,
        title: `Meeting · ${formatTime(startedAtRef.current)}`,
        startedAt: startedAtRef.current,
        durationMs,
        audioUri: path,
        status: 'recorded',
      });
      await refresh();
      log.info('record', 'saved', { id, durationMs, hasAudio: !!path });
      router.replace(`/meeting/${id}`);
    } catch (e) {
      setError('Could not save the recording.');
      log.error('record', 'stop failed', { err: String(e) });
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    try {
      if (recording) await stopPcmRecording();
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
          {recording ? 'RECORDING' : 'STARTING…'}
        </AppText>
      </View>

      <AppText variant="display" style={styles.timer}>
        {formatDuration(elapsed)}
      </AppText>
      <AppText variant="body" muted style={styles.center}>
        Recording in 16 kHz mono — ready for on-device transcription
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
