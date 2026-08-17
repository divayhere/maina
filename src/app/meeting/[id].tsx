import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { startFileSession, stopSession } from '@/core/transcription/nativeSpeech';
import { deleteMeeting, getMeeting, updateMeeting, type Meeting } from '@/data/meetings';
import { getLanguage } from '@/data/settings';
import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { segmentPath } from '@/hardware/recording/paths';
import { log } from '@/services/logger';
import { useMeetings } from '@/state/meetingsStore';
import { formatDateTime, formatDuration } from '@/utils/format';

export default function MeetingDetail() {
  const { theme } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh } = useMeetings();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [repassing, setRepassing] = useState(false);
  const [repassIdx, setRepassIdx] = useState(0);

  const repassRef = useRef(false);
  const idxRef = useRef(0);
  const textRef = useRef('');
  const meetingRef = useRef<Meeting | null>(null);
  const langRef = useRef('');

  const load = useCallback(() => {
    if (id)
      getMeeting(id).then((m) => {
        setMeeting(m);
        meetingRef.current = m;
      });
  }, [id]);

  useFocusEffect(useCallback(() => load(), [load]));

  // --- re-transcribe from the saved audio, using the same fast native engine ---
  useSpeechRecognitionEvent('result', (e) => {
    if (!repassRef.current) return;
    const t = e.results?.[0]?.transcript ?? '';
    if (e.isFinal && t) textRef.current = (textRef.current + ' ' + t).trim();
  });

  useSpeechRecognitionEvent('end', () => {
    if (!repassRef.current) return;
    const m = meetingRef.current;
    if (!m) return;
    const next = idxRef.current + 1;
    if (next < m.segmentCount) {
      idxRef.current = next;
      setRepassIdx(next);
      startFileSession({ uri: segmentPath(m.audioUri!, next), lang: langRef.current });
    } else {
      repassRef.current = false;
      setRepassing(false);
      finishRepass();
    }
  });

  const finishRepass = async () => {
    if (!id) return;
    const text = textRef.current.trim();
    if (text) {
      await updateMeeting(id, { transcript: text, status: 'transcribed' });
      log.info('meeting', 're-pass complete', { id, chars: text.length });
    } else {
      log.warn('meeting', 're-pass produced no text', { id });
    }
    load();
    await refresh();
  };

  const startRepass = async () => {
    const m = meetingRef.current;
    if (!m?.audioUri || m.segmentCount === 0) return;
    langRef.current = await getLanguage();
    textRef.current = '';
    idxRef.current = 0;
    setRepassIdx(0);
    repassRef.current = true;
    setRepassing(true);
    log.info('meeting', 're-pass start', { id, segments: m.segmentCount, lang: langRef.current });
    startFileSession({ uri: segmentPath(m.audioUri, 0), lang: langRef.current });
  };

  const cancelRepass = () => {
    repassRef.current = false;
    setRepassing(false);
    stopSession();
  };

  const deleteAudio = async () => {
    if (!id || !meeting?.audioUri) return;
    await FileSystem.deleteAsync(meeting.audioUri, { idempotent: true }).catch(() => {});
    await updateMeeting(id, { audioUri: null });
    load();
    await refresh();
  };

  const confirmDelete = () => {
    Alert.alert('Delete meeting?', 'This removes the meeting, its transcript and audio.', [
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

  const hasText = !!meeting?.transcript;
  const hasAudio = !!meeting?.audioUri && meeting.segmentCount > 0;

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
              {meeting.language ? ` · ${meeting.language}` : ''}
            </AppText>
          ) : null}
        </View>

        <Card style={{ gap: space.md }}>
          <AppText variant="label" muted>TRANSCRIPT</AppText>

          {hasText ? (
            <AppText variant="body">{meeting!.transcript}</AppText>
          ) : (
            <AppText variant="body" muted>
              No text was captured for this meeting.
            </AppText>
          )}

          {repassing ? (
            <View style={styles.busy}>
              <ActivityIndicator color={theme.accent} />
              <AppText variant="body" muted style={{ flex: 1 }}>
                Re-reading saved audio… part {repassIdx + 1}/{meeting?.segmentCount ?? 1}
              </AppText>
              <Pressable onPress={cancelRepass} hitSlop={8}>
                <AppText variant="label" muted>stop</AppText>
              </Pressable>
            </View>
          ) : hasAudio ? (
            <Pressable onPress={startRepass} style={{ paddingVertical: space.sm }}>
              <AppText variant="label" color={theme.accent}>
                {hasText ? 'Re-transcribe from saved audio' : 'Transcribe from saved audio'}
              </AppText>
            </Pressable>
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

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
          <View style={[styles.audioTag, { borderColor: theme.border }]}>
            <Ionicons
              name={hasText ? 'checkmark-circle-outline' : 'alert-circle-outline'}
              size={16}
              color={hasText ? theme.done : theme.warn}
            />
            <AppText variant="label" muted>
              {hasText ? 'Transcribed live' : 'No transcript'}
              {hasAudio ? ' · audio kept' : ''}
            </AppText>
          </View>
          {hasAudio ? (
            <Pressable onPress={deleteAudio} hitSlop={8}>
              <AppText variant="label" color={theme.muted}>delete audio</AppText>
            </Pressable>
          ) : null}
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
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
  },
});
