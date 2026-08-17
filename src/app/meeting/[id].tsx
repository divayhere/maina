import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';

import { startFileSession, stopSession, supportsOnDevice } from '@/core/transcription/nativeSpeech';
import { mergeTranscript } from '@/core/transcription/transcript';
import {
  deleteMeeting,
  getMeeting,
  listRecordingSegments,
  updateMeeting,
  type Meeting,
  type RecordingSegment,
} from '@/data/meetings';
import { getLanguage } from '@/data/settings';
import { AppText, Card } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { segmentPath } from '@/hardware/recording/paths';
import { repairWavFiles } from '@/hardware/recording/foreground';
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
  const [repassError, setRepassError] = useState<string | null>(null);

  const repassRef = useRef(false);
  const idxRef = useRef(0);
  const textRef = useRef('');
  const meetingRef = useRef<Meeting | null>(null);
  const langRef = useRef('');
  const segmentsRef = useRef<RecordingSegment[]>([]);
  const errorRef = useRef<string | null>(null);
  const retriesRef = useRef<Record<number, number>>({});

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
    if (e.isFinal && t) textRef.current = mergeTranscript(textRef.current, t);
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!repassRef.current) return;
    errorRef.current = event.error;
    log.warn('meeting', 'saved-audio recognition error', {
      index: idxRef.current,
      code: event.error,
      nativeCode: event.code,
    });
  });

  async function finishRepass() {
    if (!id) return;
    const text = textRef.current.trim();
    if (text) {
      await updateMeeting(id, {
        transcript: text,
        status: 'transcribed',
        transcribedSegments: segmentsRef.current.length,
        lastError: null,
      });
      log.info('meeting', 'saved-audio pass complete', { chars: text.length, files: segmentsRef.current.length });
    } else {
      log.warn('meeting', 're-pass produced no text', { id });
    }
    load();
    await refresh();
  }

  useSpeechRecognitionEvent('end', () => {
    if (!repassRef.current) return;
    const m = meetingRef.current;
    if (!m) return;
    if (errorRef.current) {
      const attempts = retriesRef.current[idxRef.current] ?? 0;
      if (attempts < 2) {
        retriesRef.current[idxRef.current] = attempts + 1;
        const retryIndex = idxRef.current;
        const code = errorRef.current;
        errorRef.current = null;
        log.info('meeting', 'retrying saved audio', { index: retryIndex, attempt: attempts + 1, code });
        setTimeout(() => {
          if (!repassRef.current) return;
          startFileSession({ uri: segmentsRef.current[retryIndex].audioUri, lang: langRef.current });
        }, 1000 * (attempts + 1));
        return;
      }
      const failedCode = errorRef.current;
      repassRef.current = false;
      setRepassing(false);
      setRepassError(`Part ${idxRef.current + 1} failed after 3 attempts (${failedCode}). The original transcript was kept.`);
      void updateMeeting(m.id, { status: m.transcript ? 'transcribed' : 'recorded', lastError: failedCode });
      return;
    }
    const next = idxRef.current + 1;
    if (next < segmentsRef.current.length) {
      idxRef.current = next;
      setRepassIdx(next);
      startFileSession({ uri: segmentsRef.current[next].audioUri, lang: langRef.current });
    } else {
      repassRef.current = false;
      setRepassing(false);
      finishRepass();
    }
  });

  const startRepass = async () => {
    const m = meetingRef.current;
    if (!m?.audioUri || m.segmentCount === 0) return;
    setRepassError(null);
    if (!supportsOnDevice()) {
      setRepassError('On-device speech is unavailable. Maina refused to upload the meeting audio.');
      return;
    }
    langRef.current = await getLanguage();
    let segments = await listRecordingSegments(m.id);
    if (segments.length === 0) {
      // Compatibility with recordings made before the segment table existed.
      segments = Array.from({ length: m.segmentCount }, (_, index) => ({
        meetingId: m.id,
        index,
        audioUri: segmentPath(m.audioUri!, index),
        startedAt: m.startedAt,
        status: 'recorded' as const,
      }));
    }
    await repairWavFiles(segments.map((segment) => segment.audioUri));
    segmentsRef.current = segments;
    textRef.current = '';
    idxRef.current = 0;
    errorRef.current = null;
    retriesRef.current = {};
    setRepassIdx(0);
    repassRef.current = true;
    setRepassing(true);
    await updateMeeting(m.id, { status: 'transcribing', lastError: null });
    log.info('meeting', 'saved-audio pass started', { files: segments.length, lang: langRef.current });
    startFileSession({ uri: segments[0].audioUri, lang: langRef.current });
  };

  const cancelRepass = () => {
    repassRef.current = false;
    setRepassing(false);
    stopSession();
    const m = meetingRef.current;
    if (m) void updateMeeting(m.id, { status: m.transcript ? 'transcribed' : 'recorded' });
  };

  const copyTranscript = async () => {
    if (!meeting?.transcript) return;
    await Clipboard.setStringAsync(meeting.transcript);
    Alert.alert('Copied', 'The complete transcript is on your clipboard.');
  };

  const shareMeeting = async () => {
    if (!meeting) return;
    const body = [
      `# ${meeting.title}`,
      '',
      `_${formatDateTime(meeting.startedAt)} · ${formatDuration(meeting.durationMs)}_`,
      '',
      '## Transcript',
      '',
      meeting.transcript || '_No transcript_',
      meeting.summary ? `\n\n## Summary\n\n${meeting.summary}` : '',
    ].join('\n');
    await Share.share({ title: meeting.title, message: body });
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

          {repassError ? <AppText variant="body" color={theme.warn}>{repassError}</AppText> : null}

          {hasText ? (
            <View style={{ flexDirection: 'row', gap: space.lg, flexWrap: 'wrap' }}>
              <Pressable onPress={copyTranscript}>
                <AppText variant="label" color={theme.accent}>Copy all</AppText>
              </Pressable>
              <Pressable onPress={shareMeeting}>
                <AppText variant="label" color={theme.accent}>Share as Markdown</AppText>
              </Pressable>
            </View>
          ) : null}
        </Card>

        <Card style={{ gap: space.sm }}>
          <AppText variant="label" muted>SUMMARY & TO-DOS</AppText>
          <AppText variant="body" muted>
            {meeting?.summary
              ? meeting.summary
              : 'Not generated yet. Maina keeps this manual so no meeting text leaves your phone without your action.'}
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
