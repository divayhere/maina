import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { provisionCoreLanguages } from '@/core/transcription/nativeSpeech';
import { transcriptWordCount } from '@/core/transcription/transcript';
import { initDb } from '@/data/db';
import {
  getMeeting,
  listInterruptedRecordingSegments,
  markMeetingsAudioDeleted,
  recoverInterruptedMeetings,
} from '@/data/meetings';
import { ErrorBoundary } from '@/design/ErrorBoundary';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import { repairWavFiles, stopRecordingForegroundService } from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import {
  finalizeDiagnosticRun,
  getMeetingsWithDeletedAudio,
  installRemoteLog,
  queueAudioArtifact,
  queueTextArtifact,
} from '@/services/remoteLog';
import { initSentry, Sentry } from '@/services/sentry';
import { installWatchdog } from '@/services/watchdog';

initSentry();

function RootLayout() {
  const { theme } = useAppTheme();
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    installWatchdog();
    setReady(false);
    setInitError(null);
    void (async () => {
      try {
        await installRemoteLog();
        log.info('app', 'launch');
        await initDb();

        // Snapshot unfinished rows before changing their meeting state. The
        // deterministic artifact IDs make this safe to repeat after another crash.
        const interruptedSegments = await listInterruptedRecordingSegments();
        const repaired = await repairWavFiles(interruptedSegments.map((segment) => segment.audioUri));
        const interruptedMeetingIds = [...new Set(interruptedSegments.map((segment) => segment.meetingId))];
        const recovered = await recoverInterruptedMeetings();

        for (const segment of interruptedSegments) {
          await queueAudioArtifact({
            artifactId: `${segment.meetingId}-audio-${segment.index}`,
            meetingId: segment.meetingId,
            segmentIndex: segment.index,
            sourceUri: segment.audioUri,
            durationMs: Math.max(0, (segment.endedAt ?? Date.now()) - segment.startedAt),
          });
        }
        for (const meetingId of interruptedMeetingIds) {
          const meeting = await getMeeting(meetingId);
          if (!meeting) continue;
          if (meeting.transcript?.trim()) {
            await queueTextArtifact({
              artifactId: `${meetingId}-transcript-final`,
              meetingId,
              kind: 'transcript',
              content: meeting.transcript,
            });
          }
          const segments = interruptedSegments.filter((segment) => segment.meetingId === meetingId);
          const endedAt = meeting.updatedAt || Date.now();
          await finalizeDiagnosticRun({
            runId: `recovery-${meetingId}`,
            meetingId,
            startedAt: new Date(meeting.startedAt).toISOString(),
            endedAt: new Date(Math.max(endedAt, meeting.startedAt)).toISOString(),
            status: 'interrupted',
            wallDurationMs: Math.max(0, endedAt - meeting.startedAt),
            audioDurationMs: segments.reduce(
              (sum, segment) => sum + Math.max(0, (segment.endedAt ?? endedAt) - segment.startedAt),
              0,
            ),
            expectedSegments: segments.length,
            closedSegments: segments.length,
            uploadedSegments: 0,
            transcriptWords: transcriptWordCount(meeting.transcript ?? ''),
            recognizerRestarts: meeting.restartCount,
            recognizerDowntimeMs: 0,
            measuredGapMs: 0,
            payload: { recoveredAfterProcessDeath: true, repairedWavCount: repaired },
          });
        }

        const deletedAudioMeetingIds = await getMeetingsWithDeletedAudio();
        await markMeetingsAudioDeleted(deletedAudioMeetingIds);
        await stopRecordingForegroundService().catch(() => {});
        if (recovered > 0) log.warn('recovery', 'interrupted recording recovered', { recovered, repaired });
        void provisionCoreLanguages().catch((cause) => {
          log.warn('native-speech', 'background language provisioning failed', { err: String(cause) });
        });
        setReady(true);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setInitError(message);
        log.error('init', 'database initialization failed', { err: message });
      }
    })();
  }, [attempt]);

  useEffect(() => {
    if (!ready) return;
    const syncAudioCleanup = async () => {
      const meetingIds = await getMeetingsWithDeletedAudio();
      await markMeetingsAudioDeleted(meetingIds);
    };
    void syncAudioCleanup().catch((cause) => {
      log.warn('meetings', 'audio cleanup state sync failed', { err: String(cause) });
    });
    const timer = setInterval(() => {
      void syncAudioCleanup().catch((cause) => {
        log.warn('meetings', 'audio cleanup state sync failed', { err: String(cause) });
      });
    }, 15000);
    return () => clearInterval(timer);
  }, [ready]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          {initError ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28, backgroundColor: theme.bg }}>
              <AppText variant="heading" style={{ textAlign: 'center' }}>Maina needs attention</AppText>
              <AppText variant="body" muted style={{ textAlign: 'center' }}>
                Your meetings were not changed. Database startup failed; retry or share Diagnostics after reopening.
              </AppText>
              <PrimaryButton label="Retry safely" onPress={() => setAttempt((value) => value + 1)} />
            </View>
          ) : ready ? (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="record" options={{ presentation: 'modal' }} />
              <Stack.Screen name="meeting/[id]" />
              <Stack.Screen name="diagnostics" />
            </Stack>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
              <ActivityIndicator color={theme.accent} />
            </View>
          )}
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
