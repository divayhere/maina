import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  downloadModel,
  getTranscriptionEngine,
  isModelDownloaded,
  resolveModel,
  setTranscriptionModel,
} from '@/core/transcription';
import { deleteMeeting, getMeeting, updateMeeting, type Meeting } from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { DEFAULT_CONFIG } from '@/services/config';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDateTime, formatDuration } from '@/utils/format';

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; pct: number }
  | { kind: 'transcribing' }
  | { kind: 'error'; msg: string };

export default function MeetingDetail() {
  const { theme } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh } = useMeetings();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const load = useCallback(() => {
    if (id) getMeeting(id).then(setMeeting);
  }, [id]);

  useFocusEffect(useCallback(() => load(), [load]));

  const transcribe = async () => {
    if (!id || !meeting?.audioUri) return;
    const modelId = DEFAULT_CONFIG.transcriptionModel;
    const model = resolveModel(modelId);
    try {
      const audioInfo = await FileSystem.getInfoAsync(meeting.audioUri);
      log.info('meeting', 'transcribe start', {
        id,
        audioUri: meeting.audioUri,
        audioExists: audioInfo.exists,
        audioBytes: audioInfo.exists ? (audioInfo as { size?: number }).size ?? 0 : 0,
        model: modelId,
      });
      setTranscriptionModel(modelId);
      if (!(await isModelDownloaded(modelId))) {
        setPhase({ kind: 'downloading', pct: 0 });
        await downloadModel(modelId, (pct) => setPhase({ kind: 'downloading', pct }));
      }
      setPhase({ kind: 'transcribing' });
      await updateMeeting(id, { status: 'transcribing' });

      const engine = getTranscriptionEngine();
      const result = await engine.transcribe(meeting.audioUri, {
        language: DEFAULT_CONFIG.transcriptionLanguage,
      });

      await updateMeeting(id, {
        transcript: result.text,
        language: result.language,
        status: 'transcribed',
      });

      // Privacy: delete the audio the moment we have the transcript.
      if (DEFAULT_CONFIG.audioAutoDelete && meeting.audioUri) {
        try {
          await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true });
        } catch (e) {
          log.warn('meeting', 'audio delete failed', { err: String(e) });
        }
        await updateMeeting(id, { audioUri: null });
      }

      load();
      await refresh();
      setPhase({ kind: 'idle' });
    } catch (e) {
      const msg = String(e).includes('model-not-downloaded')
        ? 'The transcription model needs to download first.'
        : 'Transcription failed. Your recording is safe — you can try again.';
      setPhase({ kind: 'error', msg });
      await updateMeeting(id, { status: 'recorded' });
      log.error('meeting', 'transcribe failed', { err: String(e) });
    }
  };

  const confirmDelete = () => {
    Alert.alert('Delete meeting?', 'This removes the meeting and its transcript.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!id) return;
          if (meeting?.audioUri) {
            try {
              await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true });
            } catch {}
          }
          await deleteMeeting(id);
          await refresh();
          router.back();
        },
      },
    ]);
  };

  const busy = phase.kind === 'downloading' || phase.kind === 'transcribing';

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.topbar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
        <Pressable onPress={confirmDelete} hitSlop={12}>
          <Ionicons name="trash-outline" size={22} color={theme.rec} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <View style={{ gap: space.xs }}>
          <AppText variant="title">{meeting?.title ?? 'Meeting'}</AppText>
          {meeting ? (
            <AppText variant="body" muted>
              {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.durationMs)}
              {meeting.language ? ` · ${meeting.language.toUpperCase()}` : ''}
            </AppText>
          ) : null}
        </View>

        <Card style={{ gap: space.md }}>
          <AppText variant="label" muted>TRANSCRIPT</AppText>

          {meeting?.transcript ? (
            <AppText variant="body">{meeting.transcript}</AppText>
          ) : busy ? (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.accent} />
              <AppText variant="body" muted>
                {phase.kind === 'downloading'
                  ? `Downloading model… ${Math.round(phase.pct * 100)}% (${resolveModel(DEFAULT_CONFIG.transcriptionModel).label})`
                  : 'Transcribing on your device…'}
              </AppText>
            </View>
          ) : meeting?.audioUri ? (
            <>
              <AppText variant="body" muted>
                Runs fully on your phone. First time downloads the model (~148 MB); after that it&apos;s offline and free.
              </AppText>
              {phase.kind === 'error' ? (
                <AppText variant="label" color={theme.warn}>{phase.msg}</AppText>
              ) : null}
              <PrimaryButton label="Transcribe" onPress={transcribe} />
            </>
          ) : (
            <AppText variant="body" muted>No audio available to transcribe.</AppText>
          )}
        </Card>

        <Card style={{ gap: space.sm }}>
          <AppText variant="label" muted>SUMMARY & TO-DOS</AppText>
          <AppText variant="body" muted>
            {meeting?.summary
              ? meeting.summary
              : 'Summaries and to-dos arrive in Phase 3, generated by your chosen AI.'}
          </AppText>
        </Card>

        <View style={[styles.audioTag, { borderColor: theme.border }]}>
          <Ionicons
            name={
              meeting?.transcript
                ? 'checkmark-circle-outline'
                : meeting?.audioUri
                  ? 'musical-note'
                  : 'alert-circle-outline'
            }
            size={16}
            color={meeting?.transcript ? theme.done : meeting?.audioUri ? theme.accent : theme.warn}
          />
          <AppText variant="label" muted>
            {meeting?.transcript
              ? 'Transcribed · audio deleted'
              : meeting?.audioUri
                ? 'Audio captured'
                : 'No audio file'}
          </AppText>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.xxxl,
    paddingBottom: space.sm,
  },
  busy: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  audioTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
});
