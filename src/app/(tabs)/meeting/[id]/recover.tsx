import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { getMeeting, getTranscriptSummary, listRecordingSegments, type Meeting } from '@/data/meetings';
import { AppText, Banner, Card, Chip, PrimaryButton, SectionLabel } from '@/design/components';
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
      <TopBar title={meeting?.title ?? 'Recovered recording'} back />

      <View style={[styles.content, { paddingTop: topPadding, paddingBottom: contentBottomPadding }]}>
        <View style={{ gap: space.sm }}>
          {meeting ? (
            <AppText variant="meta" muted>
              {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} · {formatDuration(meeting.durationMs)}
            </AppText>
          ) : null}
          <Chip label="Recording stopped early" tone="warn" />
        </View>

        <Banner tone="warn" style={{ gap: space.md }}>
          <AppText variant="title">Maina saved what it had</AppText>
          <AppText variant="body" muted>
            This recording was interrupted. You can keep the saved text, and if audio is still available you can ask Maina to retry transcription.
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
          <PrimaryButton label="Open transcript safely" onPress={() => router.push(`/meeting/${id}?allowInterrupted=1`)} />
          {audioAvailable ? (
            <PrimaryButton
              label="Retry transcription from saved audio"
              onPress={() => router.push(`/meeting/${id}?allowInterrupted=1&startRepass=1`)}
            />
          ) : null}
          <PrimaryButton
            label={sharing ? 'Preparing export...' : 'Save a copy'}
            onPress={shareCurrentTranscript}
          />
        </View>

        {meeting ? (
          <Card style={{ gap: space.sm }}>
            <SectionLabel>What happens next</SectionLabel>
            <AppText variant="body" muted>
              Open the transcript to inspect what was saved. If the audio is still here, retry transcription from saved audio. Once the transcript looks right, you can write notes from the meeting page.
            </AppText>
          </Card>
        ) : null}
      </View>
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
