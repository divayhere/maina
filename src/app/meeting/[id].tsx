import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import {
  downloadModel,
  isModelDownloaded,
  LOCAL_MODEL,
  setTranscriptionModel,
  transcribeMeeting,
} from '@/core/transcription';
import { deleteMeeting, getMeeting, type Meeting } from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDateTime, formatDuration } from '@/utils/format';

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; pct: number }
  | { kind: 'transcribing'; done: number; total: number }
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
    const modelId = LOCAL_MODEL.id;
    try {
      setTranscriptionModel(modelId);
      log.info('meeting', 'transcribe requested', {
        id,
        segments: meeting.segmentCount,
        done: meeting.transcribedSegments,
        model: modelId,
      });
      if (!(await isModelDownloaded(modelId))) {
        setPhase({ kind: 'downloading', pct: 0 });
        await downloadModel(modelId, (pct) => setPhase({ kind: 'downloading', pct }));
      }
      setPhase({ kind: 'transcribing', done: meeting.transcribedSegments, total: meeting.segmentCount });
      await transcribeMeeting(id, (done, total) => {
        setPhase({ kind: 'transcribing', done, total });
        load();
      });
      load();
      await refresh();
      setPhase({ kind: 'idle' });
    } catch (e) {
      const s = String(e);
      const interrupted =
        s.includes('download-incomplete') || s.includes('connection abort') || s.includes('Network');
      setPhase({
        kind: 'error',
        msg: interrupted
          ? 'Download was interrupted. Tap to resume — it picks up where it left off.'
          : 'Transcription hit a snag. Your recording is safe — tap to resume.',
      });
      log.error('meeting', 'transcribe failed', { err: s });
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
            await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true }).catch(() => {});
          }
          await deleteMeeting(id);
          await refresh();
          router.back();
        },
      },
    ]);
  };

  const busy = phase.kind === 'downloading' || phase.kind === 'transcribing';
  const complete = !!meeting && meeting.segmentCount > 0 && meeting.transcribedSegments >= meeting.segmentCount;
  const canTranscribe = !!meeting?.audioUri && meeting.segmentCount > 0 && !complete;
  const resuming = !!meeting && meeting.transcribedSegments > 0 && !complete;

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

          {meeting?.transcript ? <AppText variant="body">{meeting.transcript}</AppText> : null}

          {busy ? (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.accent} />
              <AppText variant="body" muted style={{ flex: 1 }}>
                {phase.kind === 'downloading'
                  ? `Downloading ${LOCAL_MODEL.label}… ${Math.round(phase.pct * 100)}% (one-time, ~547 MB)`
                  : `Transcribing on your device… segment ${phase.done}/${phase.total}`}
              </AppText>
            </View>
          ) : canTranscribe ? (
            <>
              {!meeting?.transcript ? (
                <AppText variant="body" muted>
                  Runs fully on your phone. First time downloads the model (~547 MB, Wi-Fi); after that it&apos;s offline and free.
                </AppText>
              ) : null}
              {phase.kind === 'error' ? (
                <AppText variant="label" color={theme.warn}>{phase.msg}</AppText>
              ) : null}
              <PrimaryButton label={resuming ? 'Resume transcription' : 'Transcribe'} onPress={transcribe} />
            </>
          ) : !meeting?.transcript ? (
            <AppText variant="body" muted>No audio available to transcribe.</AppText>
          ) : null}
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
            name={complete ? 'checkmark-circle-outline' : meeting?.audioUri ? 'musical-note' : 'alert-circle-outline'}
            size={16}
            color={complete ? theme.done : meeting?.audioUri ? theme.accent : theme.warn}
          />
          <AppText variant="label" muted>
            {complete
              ? 'Transcribed · audio deleted'
              : meeting?.audioUri
                ? `Audio captured · ${meeting.segmentCount} segment${meeting.segmentCount === 1 ? '' : 's'}`
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
