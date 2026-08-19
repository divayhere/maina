import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { getMeeting, getTranscriptSummary, listRecordingSegments, type Meeting } from '@/data/meetings';
import { AppText, Card, PrimaryButton } from '@/design/components';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { radius, space } from '@/design/tokens';
import { ensureStorageBudget } from '@/services/storageBudget';
import { shareMeetingExport } from '@/services/transcriptExport';
import { formatDateTime, formatDuration } from '@/utils/format';

export default function MeetingRecoveryScreen() {
  const { theme } = useAppTheme();
  const { topPadding, contentBottomPadding } = useMainaLayout();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [audioSegments, setAudioSegments] = useState(0);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [sharing, setSharing] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    void (async () => {
      const [nextMeeting, summary, segments] = await Promise.all([
        getMeeting(id),
        getTranscriptSummary(id),
        listRecordingSegments(id).catch(() => []),
      ]);
      setMeeting(nextMeeting);
      setBlockCount(summary.blockCount);
      setAudioSegments(segments.length);
      setAudioAvailable(segments.length > 0 || !!nextMeeting?.audioUri);
    })();
  }, [id]);

  useFocusEffect(useCallback(() => {
    load();
  }, [load]));

  const shareCurrentTranscript = async () => {
    if (!meeting) return;
    const storageDecision = await ensureStorageBudget('export');
    if (!storageDecision.ok) return;
    setSharing(true);
    try {
      await shareMeetingExport(meeting);
    } finally {
      setSharing(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.topbar, { paddingTop: topPadding }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={26} color={theme.text} />
        </Pressable>
      </View>

      <View style={[styles.content, { paddingBottom: contentBottomPadding }]}>
        <View style={{ gap: space.xs }}>
          <AppText variant="title">{meeting?.title ?? 'Recovered meeting'}</AppText>
          {meeting ? (
            <AppText variant="body" muted>
              {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.durationMs)}
            </AppText>
          ) : null}
        </View>

        <Card style={{ gap: space.md }}>
          <AppText variant="label" muted>RECOVERY</AppText>
          <AppText variant="body">
            Maina recovered this meeting after an interrupted recording session. Open the transcript only when you want to inspect it; the recovery screen stays light on purpose.
          </AppText>
          <View style={{ gap: space.xs }}>
            <AppText variant="body" muted>Status: {meeting?.status ?? 'unknown'}</AppText>
            <AppText variant="body" muted>Transcript blocks: {blockCount}</AppText>
            <AppText variant="body" muted>Saved audio segments: {audioSegments}</AppText>
            <AppText variant="body" muted>Audio available: {audioAvailable ? 'Yes' : 'No'}</AppText>
            {meeting?.lastError ? <AppText variant="body" color={theme.warn}>Last error: {meeting.lastError}</AppText> : null}
          </View>
        </Card>

        <View style={{ gap: space.md }}>
          <PrimaryButton label="Open transcript safely" onPress={() => router.push(`/meeting/${id}?allowInterrupted=1`)} />
          {audioAvailable ? (
            <PrimaryButton
              label="Retry transcription from saved audio"
              onPress={() => router.push(`/meeting/${id}?allowInterrupted=1&startRepass=1`)}
            />
          ) : null}
          <PrimaryButton
            label={sharing ? 'Preparing export…' : 'Share current transcript'}
            onPress={shareCurrentTranscript}
          />
        </View>

        {!meeting ? (
          <View style={{ paddingTop: space.lg }}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  tag: {
    borderRadius: radius.pill,
  },
});
