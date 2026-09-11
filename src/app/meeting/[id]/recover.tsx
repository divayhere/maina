import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { acceptSavedMeetingResult, getMeeting, getTranscriptSummary, listRecordingSegments, newId, type Meeting } from '@/data/meetings';
import { AppText, Banner, Card, Chip, PrimaryButton, SecondaryButton, SectionLabel } from '@/design/components';
import { TopBar } from '@/design/shell';
import { useMainaLayout } from '@/design/layout';
import { useAppTheme } from '@/design/theme';
import { space } from '@/design/tokens';
import {
  getNativeCaptureQuarantine,
  inspectNativeCaptureDirectory,
  recoverNativeCaptureQuarantine,
} from '@/hardware/recording/foreground';
import { candidateRecoveryAudioUris } from '@/core/recording/recoveryAudio';
import { ensureStorageBudget } from '@/services/storageBudget';
import { discardNativeMeeting } from '@/services/nativeDiscard';
import { readNativeCaptureAutomaticWorkFence } from '@/services/nativeCaptureQuarantineFence';
import { useMeetings } from '@/state/meetingsStore';
import { shareMeetingExport } from '@/services/transcriptExport';
import {
  flushDiagnostics,
  retryFailedDiagnosticArtifacts,
  setQuarantineDiagnosticMeetingIds,
} from '@/services/remoteLog';
import { formatDate, formatDuration, formatTime } from '@/utils/format';

function formatMeetingLength(meeting: Pick<Meeting, 'durationMs' | 'audioDurationMs' | 'captureGapMs'>): string {
  const elapsedMs = Math.max(0, meeting.durationMs);
  const recordedMs = Math.max(0, meeting.audioDurationMs ?? 0);
  const gapMs = Math.max(0, meeting.captureGapMs ?? 0);
  if (recordedMs > 0 && gapMs >= 1_000) {
    return `${formatDuration(recordedMs)} recorded · ${formatDuration(gapMs)} interrupted`;
  }
  return formatDuration(recordedMs || elapsedMs);
}

export default function MeetingRecoveryScreen() {
  const { theme } = useAppTheme();
  const { contentBottomPadding, topPadding } = useMainaLayout();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh } = useMeetings();
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [audioSegments, setAudioSegments] = useState(0);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [legacyQuarantined, setLegacyQuarantined] = useState(false);
  const [nativeQuarantineBlocked, setNativeQuarantineBlocked] = useState(false);
  const quarantineDiscardIdRef = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    void (async () => {
      const [nextMeeting, summary, segments] = await Promise.all([
        getMeeting(id),
        getTranscriptSummary(id),
        listRecordingSegments(id).catch(() => []),
      ]);
      setMeeting(nextMeeting);
      let quarantine: ReturnType<typeof getNativeCaptureQuarantine> = { state: 'none' };
      if (Platform.OS === 'android') {
        try {
          quarantine = getNativeCaptureQuarantine();
        } catch {
          quarantine = { state: 'blocked' };
        }
      }
      setLegacyQuarantined(quarantine.state === 'legacy_terminal' && quarantine.meetingId === id);
      setNativeQuarantineBlocked(quarantine.state === 'blocked');
      setBlockCount(summary.blockCount);
      const nativeInspection = nextMeeting?.audioUri
        ? await inspectNativeCaptureDirectory(nextMeeting.audioUri, false).catch(() => null)
        : null;
      const candidateUris = candidateRecoveryAudioUris(
        nativeInspection?.finalizedUris ?? [],
        segments.map((segment) => segment.audioUri),
      );
      const readableSegmentCount = (await Promise.all(candidateUris.map(async (uri) => (
        (await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false }))).exists
      )))).filter(Boolean).length;
      setAudioSegments(readableSegmentCount);
      setAudioAvailable(readableSegmentCount > 0);
      if (nextMeeting?.captureHeartbeatTerminalAt
        && !['recording', 'interrupted'].includes(nextMeeting.status)
      ) {
        router.replace(`/meeting/${nextMeeting.id}?allowInterrupted=1`);
      }
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
      if (legacyQuarantined) await recoverNativeCaptureQuarantine(meeting.id);
      if (legacyQuarantined) {
        const fence = await readNativeCaptureAutomaticWorkFence();
        setQuarantineDiagnosticMeetingIds(fence.protectedMeetingIds);
        if (fence.protectedMeetingIds.length === 0) {
          await retryFailedDiagnosticArtifacts().catch(() => 0);
          await flushDiagnostics().catch(() => {});
        }
      }
      await acceptSavedMeetingResult(meeting.id);
      await refresh();
      router.replace(`/meeting/${meeting.id}`);
    } catch {
      Alert.alert(
        'Could not recover the recording',
        'Maina kept the saved recording. Reopen it to finish recovery safely.',
      );
    } finally {
      setAccepting(false);
    }
  };

  const confirmDiscardQuarantine = () => {
    if (!meeting || !legacyQuarantined || discarding) return;
    Alert.alert(
      'Discard this recovered recording?',
      "The saved audio and meeting are removed from this phone. This can't be undone.",
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            const discardId = quarantineDiscardIdRef.current ?? newId();
            quarantineDiscardIdRef.current = discardId;
            setDiscarding(true);
            void discardNativeMeeting({ meetingId: meeting.id, discardId })
              .then(async () => {
                const fence = await readNativeCaptureAutomaticWorkFence();
                setQuarantineDiagnosticMeetingIds(fence.protectedMeetingIds);
                if (fence.protectedMeetingIds.length === 0) {
                  await flushDiagnostics().catch(() => {});
                }
                await refresh();
                router.dismissTo('/');
              })
              .catch(() => {
                setDiscarding(false);
                Alert.alert(
                  'Discard is still pending',
                  'Maina retained the recovery record and will finish it safely when the app is reopened.',
                );
              });
          },
        },
      ],
    );
  };

  return (
    <View testID="meeting-recovery-root" style={{ flex: 1, backgroundColor: theme.bg }}>
      <TopBar title={meeting?.title ?? 'Recovered recording'} back />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: topPadding, paddingBottom: contentBottomPadding }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: space.sm }}>
          {meeting ? (
            <AppText testID="meeting-recovery-metadata" variant="meta" muted>
              {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} · {formatMeetingLength(meeting)}{meeting.language ? ` · ${meeting.language}` : ''}
            </AppText>
          ) : null}
          {meeting ? (
            <View collapsable={false} testID={`meeting-recovery-correlation-${meeting.id}`} style={{ width: 1, height: 1 }} />
          ) : null}
          <Chip label="Recording stopped early" tone="warn" />
        </View>

        <Banner tone="warn" style={{ gap: space.md }}>
          <AppText variant="title">
            {nativeQuarantineBlocked
              ? 'Recording recovery is unavailable'
              : legacyQuarantined ? 'Previous recording needs your choice' : 'Recording ended early'}
          </AppText>
          <AppText variant="body" muted>
            {nativeQuarantineBlocked
              ? 'Maina could not verify native recording ownership. Your saved audio remains untouched; reopen the app before choosing what to do.'
              : legacyQuarantined
              ? 'Maina preserved the recording, but the older app did not retain whether you chose Save or Discard. Recover the saved audio or explicitly discard it.'
              : 'Choose what Maina should do with the saved result.'}
          </AppText>
        </Banner>

        <Card style={{ gap: space.md }}>
          <SectionLabel>Recovery details</SectionLabel>
          {meeting ? (
            <View style={{ gap: space.sm }}>
              <AppText variant="meta" muted>Transcript blocks: {blockCount}</AppText>
              <AppText testID="meeting-recovery-segments" variant="meta" muted>Saved audio segments: {audioSegments}</AppText>
              <AppText testID="meeting-recovery-audio" variant="meta" muted>Audio available: {audioAvailable ? 'Yes' : 'No'}</AppText>
            </View>
          ) : (
            <ActivityIndicator color={theme.primary} />
          )}
        </Card>

        <View style={{ gap: space.md }}>
          {audioAvailable && !legacyQuarantined && !nativeQuarantineBlocked ? (
            <PrimaryButton
              testID="meeting-recovery-retranscribe"
              label="Re-transcribe from saved audio"
              onPress={() => router.replace(`/meeting/${id}?allowInterrupted=1&startRepass=1`)}
            />
          ) : null}
          {!legacyQuarantined && !nativeQuarantineBlocked ? (
            <SecondaryButton testID="meeting-recovery-open-saved" label="Open saved transcript" onPress={() => router.replace(`/meeting/${id}?allowInterrupted=1`)} />
          ) : null}
          {!nativeQuarantineBlocked ? (
            <SecondaryButton
              testID={legacyQuarantined ? 'meeting-recovery-resolve-save' : undefined}
              label={accepting
                ? 'Recovering saved audio...'
                : legacyQuarantined ? 'Recover saved audio' : 'Keep saved result'}
              disabled={accepting}
              onPress={() => void acceptSavedResult()}
            />
          ) : null}
          {legacyQuarantined && !nativeQuarantineBlocked ? (
            <SecondaryButton
              testID="meeting-recovery-resolve-discard"
              label={discarding ? 'Discarding...' : 'Discard this recording'}
              disabled={discarding || accepting}
              onPress={confirmDiscardQuarantine}
            />
          ) : !nativeQuarantineBlocked ? (
            <SecondaryButton
              label={sharing ? 'Preparing export...' : 'Save a copy'}
              disabled={sharing}
              onPress={shareCurrentTranscript}
            />
          ) : null}
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
