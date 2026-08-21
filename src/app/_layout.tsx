import { router, Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, PermissionsAndroid, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { provisionCoreLanguages, requestSpeechPermissions } from '@/core/transcription/nativeSpeech';
import { initDb } from '@/data/db';
import {
  getMeeting,
  getTranscriptSummary,
  listMeetings,
  listInterruptedRecordingSegments,
  markMeetingsAudioDeleted,
  recoverInterruptedMeetings,
  startRecordingSegment,
  finishRecordingSegment,
  updateMeeting,
} from '@/data/meetings';
import { ErrorBoundary } from '@/design/ErrorBoundary';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import {
  getPcmWavDurationsMs,
  getNativeCaptureStatus,
  armRemoteControl,
  inspectNativeCaptureDirectory,
  repairWavFiles,
} from '@/hardware/recording/foreground';
import { installHardwareTriggerListener } from '@/hardware/trigger/hardwareTrigger';
import { resolveRemoteAction } from '@/hardware/trigger/remoteControl';
import { log } from '@/services/logger';
import { enforceAudioRetentionPolicy } from '@/services/audioRetention';
import {
  finalizeDiagnosticRun,
  flushDiagnostics,
  getMeetingsWithDeletedAudio,
  getDiagnosticsStatus,
  installRemoteLog,
  queueAudioArtifact,
} from '@/services/remoteLog';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { reconcilePendingMeetingPackets } from '@/services/meetingPacket';
import { initSentry, Sentry } from '@/services/sentry';
import { installWatchdog } from '@/services/watchdog';

initSentry();

function RootLayout() {
  const { theme } = useAppTheme();
  const [fontsLoaded] = useFonts({
    'PlusJakartaSans-Regular': require('@/assets/fonts/PlusJakartaSans-Regular.ttf'),
    'PlusJakartaSans-Medium': require('@/assets/fonts/PlusJakartaSans-Medium.ttf'),
    'PlusJakartaSans-SemiBold': require('@/assets/fonts/PlusJakartaSans-SemiBold.ttf'),
    'PlusJakartaSans-Bold': require('@/assets/fonts/PlusJakartaSans-Bold.ttf'),
    'PlusJakartaSans-ExtraBold': require('@/assets/fonts/PlusJakartaSans-ExtraBold.ttf'),
  });
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
        const diagnostics = await getDiagnosticsStatus().catch(() => null);
        if (diagnostics) {
          log[diagnostics.enabled ? 'info' : 'warn']('remote', 'diagnostics bridge ready', {
            enabled: diagnostics.enabled,
            pendingEvents: diagnostics.pendingEvents,
            pendingArtifacts: diagnostics.pendingArtifacts,
            failedArtifacts: diagnostics.failedArtifacts,
            lastError: diagnostics.lastError ?? null,
          });
          await flushDiagnostics().catch(() => {});
        }
        log.info('app', 'launch');
        await initDb();

        // A process death can leave the active native WAV as *.partial. Finalize
        // it before converting the meeting row to "interrupted", then register
        // every recovered chunk so the ordinary recovery screen can re-run ASR.
        const activeMeetings = (await listMeetings()).filter(
          (meeting) => meeting.status === 'recording' && !!meeting.audioUri,
        );
        const liveMeetingIds: string[] = [];
        for (const meeting of activeMeetings) {
          const liveCapture = getNativeCaptureStatus();
          if (liveCapture?.meetingId === meeting.id && liveCapture.state !== 'idle' && liveCapture.state !== 'error') {
            liveMeetingIds.push(meeting.id);
            log.info('recovery', 'active native capture left untouched during UI restart', {
              meetingId: meeting.id,
              state: liveCapture.state,
            });
            continue;
          }
          const inspection = await inspectNativeCaptureDirectory(meeting.audioUri!, true).catch((cause) => {
            log.error('recovery', 'native capture directory recovery failed', {
              meetingId: meeting.id,
              err: String(cause),
            });
            return null;
          });
          if (!inspection) continue;
          for (let index = 0; index < inspection.finalizedUris.length; index += 1) {
            const uri = inspection.finalizedUris[index];
            await startRecordingSegment(meeting.id, index, uri).catch(() => {});
            await finishRecordingSegment(meeting.id, index, uri).catch(() => {});
          }
          await updateMeeting(meeting.id, {
            segmentCount: inspection.finalizedUris.length,
            lastError: inspection.partialUris.length > 0
              ? 'Some recovery audio still needs finalization.'
              : null,
          });
          log.warn('recovery', 'native capture directory recovered after restart', {
            meetingId: meeting.id,
            finalizedChunks: inspection.finalizedUris.length,
            recoveredChunks: inspection.recoveredCount,
            remainingPartials: inspection.partialUris.length,
          });
        }

        // Snapshot unfinished rows before changing their meeting state. The
        // deterministic artifact IDs make this safe to repeat after another crash.
        const interruptedSegments = await listInterruptedRecordingSegments();
        const repaired = await repairWavFiles(interruptedSegments.map((segment) => segment.audioUri));
        const recoveredDurations = await getPcmWavDurationsMs(
          interruptedSegments.map((segment) => segment.audioUri),
        );
        const interruptedMeetingIds = [...new Set(interruptedSegments.map((segment) => segment.meetingId))];
        const recovered = await recoverInterruptedMeetings(liveMeetingIds);

        for (const segment of interruptedSegments) {
          await queueAudioArtifact({
            artifactId: `${segment.meetingId}-audio-${segment.index}`,
            meetingId: segment.meetingId,
            segmentIndex: segment.index,
            sourceUri: segment.audioUri,
            durationMs: recoveredDurations[segment.audioUri] ?? 0,
          });
        }
        for (const meetingId of interruptedMeetingIds) {
          const meeting = await getMeeting(meetingId);
          if (!meeting) continue;
          const transcriptSummary = await getTranscriptSummary(meetingId);
          const segments = interruptedSegments.filter((segment) => segment.meetingId === meetingId);
          const wallDurationMs = Math.max(0, meeting.durationMs);
          const endedAt = meeting.startedAt + wallDurationMs;
          const audioDurationMs = segments.reduce(
            (sum, segment) => sum + Math.max(0, recoveredDurations[segment.audioUri] ?? 0),
            0,
          );
          const closedSegments = segments.filter(
            (segment) => (recoveredDurations[segment.audioUri] ?? 0) > 0,
          ).length;
          const measuredGapMs = Math.max(0, wallDurationMs - audioDurationMs);
          await finalizeDiagnosticRun({
            runId: `recovery-${meetingId}`,
            meetingId,
            startedAt: new Date(meeting.startedAt).toISOString(),
            endedAt: new Date(Math.max(endedAt, meeting.startedAt)).toISOString(),
            status: 'interrupted',
            wallDurationMs,
            audioDurationMs,
            expectedSegments: segments.length,
            closedSegments,
            uploadedSegments: 0,
            transcriptWords: transcriptSummary.wordCount,
            recognizerRestarts: meeting.restartCount,
            recognizerDowntimeMs: 0,
            measuredGapMs,
            payload: {
              recoveredAfterProcessDeath: true,
              repairedWavCount: repaired,
              metricsProvenance: 'persisted-wall-duration-and-wav-byte-length',
              recognizerDowntimeMeasurement: 'unavailable-after-process-death',
              uploadedSegmentsMeasuredAt: 'run-finalization-before-background-worker',
            },
          });
        }

        const deletedAudioMeetingIds = await getMeetingsWithDeletedAudio();
        await markMeetingsAudioDeleted(deletedAudioMeetingIds);
        await enforceAudioRetentionPolicy();
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null);
        }
        const microphoneReady = await requestSpeechPermissions();
        if (microphoneReady) {
          const control = await armRemoteControl();
          log.info('trigger', 'remote control armed', {
            notificationsEnabled: control.notificationsEnabled,
            inputDevices: control.inputDevices,
          });
        } else {
          log.warn('trigger', 'remote control not armed because microphone permission is missing');
        }
        if (recovered > 0) log.warn('recovery', 'interrupted recording recovered', { recovered, repaired });
        void provisionCoreLanguages().catch((cause) => {
          log.warn('native-speech', 'background language provisioning failed', { err: String(cause) });
        });
        void reconcilePendingMeetingPackets().catch((cause) => {
          log.warn('summary', 'pending packet reconciliation failed', { err: String(cause) });
        });
        void reconcilePendingMainaKnowledgeCloudSyncs().catch((cause) => {
          log.warn('maina-cloud', 'pending cloud sync reconciliation failed', { err: String(cause) });
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
      await enforceAudioRetentionPolicy();
      await reconcilePendingMeetingPackets();
      await reconcilePendingMainaKnowledgeCloudSyncs();
      await flushDiagnostics().catch(() => {});
    };
    void syncAudioCleanup().catch((cause) => {
      log.warn('meetings', 'audio cleanup state sync failed', { err: String(cause) });
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void syncAudioCleanup().catch((cause) => {
        log.warn('meetings', 'audio cleanup state sync failed', { err: String(cause) });
      });
    });
    return () => subscription.remove();
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    return installHardwareTriggerListener((event) => {
      const action = resolveRemoteAction('idle', event.command);
      log.info('trigger', 'idle remote action resolved', { command: event.command, action });
      if (action === 'start') router.push('/record');
      else log.info('trigger', 'idle remote command ignored', { command: event.command });
    });
  }, [ready]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ErrorBoundary>
          {!fontsLoaded ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.bg }}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : initError ? (
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
