import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { acceptSavedMeetingResult, getMeeting, getTranscriptSummary, listRecordingSegments, type Meeting } from '@/data/meetings';
import { AppText, Banner, Card, Chip, PrimaryButton, SecondaryButton, SectionLabel } from '@/design/components';
import { TopBar } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import { ensureStorageBudget } from '@/services/storageBudget';
import { shareMeetingExport } from '@/services/transcriptExport';
import { formatDate, formatDuration, formatTime } from '@/utils/format';

export default function MeetingRecoveryScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [audioSegments, setAudioSegments] = useState(0);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [accepting, setAccepting] = useState(false);

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

  const acceptSavedResult = async () => {
    if (!meeting) return;
    setAccepting(true);
    try {
      await acceptSavedMeetingResult(meeting.id);
      router.replace(`/meeting/${meeting.id}`);
    } finally {
      setAccepting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title={meeting?.title ?? 'Recovered recording'} back />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: topPadding, paddingBottom: contentBottomPadding }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space.sm }}>
          {meeting ? (
            <AppText variant="meta" muted>
              {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} · {formatDuration(meeting.durationMs)}
            </AppText>
          ) : null}
          <Chip label="Recording stopped early" tone="warn" />
        </View>

        <Banner tone="warn" style={{ gap: space.md }}>
          <AppText variant="title">Recording ended early</AppText>
          <AppText variant="body" muted>
            Choose what Maina should do with the saved result.
          </AppText>
        </Banner>

        <Card style={{ gap: space.md }}>
          <SectionLabel>Recovery details</SectionLabel>
          {meeting ? (
            <View style={{ gap: space.sm }}>
              <AppText variant="meta" muted>Transcript blocks: {blockCount}</AppText>
              <AppText variant="meta" muted>Saved audio segments: {audioSegments}</AppText>
              <AppText variant="meta" muted>Audio available: {audioAvailable ? 'Yes' : 'No'}</AppText>
            </View>
          ) : (
            <ActivityIndicator color={theme.primary} />
          )}
        </Card>

        <View style={{ gap: space.md }}>
          {audioAvailable ? (
            <PrimaryButton
              label="Re-transcribe from saved audio"
              onPress={() => router.push(`/meeting/${id}?allowInterrupted=1&startRepass=1`)}
            />
          ) : null}
          <SecondaryButton label="Open saved transcript" onPress={() => router.push(`/meeting/${id}?allowInterrupted=1`)} />
          <SecondaryButton
            label={accepting ? 'Keeping saved result...' : 'Keep saved result'}
            disabled={accepting}
            onPress={() => void acceptSavedResult()}
          />
          <SecondaryButton
            label={sharing ? 'Preparing export...' : 'Save a copy'}
            disabled={sharing}
            onPress={shareCurrentTranscript}
          />
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: space.xl,
    gap: space.xl,
  },
});
