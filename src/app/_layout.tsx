import { router, Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, PermissionsAndroid, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';

import { provisionCoreLanguages, requestSpeechPermissions } from '@/core/transcription/nativeSpeech';
import { createEarlierDeadlineTimer } from '@/core/pipeline/earlierDeadlineTimer';
import { createPacketPollSignalCoalescer, nextPacketPollDelay } from '@/core/pipeline/pipelineScheduling';
import { initDb } from '@/data/db';
import {
  getMeeting,
  getTranscriptSummary,
  listMeetings,
  listInterruptedRecordingSegments,
  markMeetingsAudioDeleted,
  startRecordingSegment,
  finishRecordingSegment,
  getNextMeetingPacketRetryAt,
  repairStoredRecordingReferences,
  updateMeeting,
} from '@/data/meetings';
import { ErrorBoundary } from '@/design/ErrorBoundary';
import { AppText, PrimaryButton } from '@/design/components';
import { useAppTheme } from '@/design/theme';
import {
  getPcmWavDurationsMs,
  getIOSAutomationScenario,
  getNativeCaptureStatusAsync,
  armRemoteControl,
  inspectNativeCaptureDirectory,
  repairWavFiles,
  subscribeNativePostProcessingChanges,
} from '@/hardware/recording/foreground';
import { installHardwareTriggerListener } from '@/hardware/trigger/hardwareTrigger';
import { resolveRemoteAction } from '@/hardware/trigger/remoteControl';
import { log } from '@/services/logger';
import { reconcilePendingNativeMeetingWork } from '@/services/meetingCaptureLifecycle';
import { enforceAudioRetentionPolicy } from '@/services/audioRetention';
import {
  finalizeDiagnosticRun,
  flushDiagnostics,
  getMeetingsWithDeletedAudio,
  getDiagnosticsStatus,
  installRemoteLog,
  queueAudioArtifact,
} from '@/services/remoteLog';
import { queueEligibleMeetingPackets, reconcilePendingMeetingPackets } from '@/services/meetingPacket';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { reconcilePendingMainaKnowledgeCloudCorrections } from '@/services/mainaKnowledgeCloudCorrections';
import { exchangeMainaCloudPairing } from '@/services/mainaCloudSession';
import { subscribeMeetingPipelineChanges } from '@/services/meetingPipelineSignals';
import { initSentry, Sentry } from '@/services/sentry';
import { installWatchdog } from '@/services/watchdog';
import { clearLegacyDirectAiConfiguration } from '@/services/config';
import {
  registerBackgroundPipelineRecovery,
  runDurablePipelineWake,
} from '@/services/backgroundPipeline';
import {
  registerNativePipelineWakeScheduler,
  repairDurablePipelineScheduling,
  requestDurablePipelineWake,
} from '@/services/pipelineWakeScheduler';
import {
  claimPendingNativePipelineWake,
  scheduleNativePipelineWake,
  subscribeNativePipelineWakeRequests,
} from '@/hardware/pipelineWake';
import { runNativePipelineWakeTask } from '@/headless/registerPipelineWake';
import { persistPipelineConnectivity } from '@/data/pipelineWake';
import { createPipelineForegroundStarter } from '@/services/pipelineForegroundStart';
import { createPipelineWakeCoordinator } from '@/services/pipelineWakeCoordinator';

initSentry();

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

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
        await repairStoredRecordingReferences();
        // Previous staging builds stored direct provider and MKC values in
        // SQLite. Cloud notes now use a scoped SecureStore session only.
        await clearLegacyDirectAiConfiguration();
        const backgroundRecoveryRegistered = await registerBackgroundPipelineRecovery().catch((cause) => {
          log.warn('background-pipeline', 'background recovery registration unavailable', { err: String(cause) });
          return false;
        });
        log.info('background-pipeline', 'background recovery registration checked', {
          registered: backgroundRecoveryRegistered,
        });

        // A process death can leave the active native WAV as *.partial. Finalize
        // it before trying to resume native post-processing from durable audio.
        const activeMeetings = (await listMeetings()).filter(
          (meeting) => meeting.status === 'recording' && !!meeting.audioUri,
        );
        const liveMeetingIds: string[] = [];
        for (const meeting of activeMeetings) {
          const liveCapture = await getNativeCaptureStatusAsync().catch(() => null);
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
        const resumedNativeMeetings = await reconcilePendingNativeMeetingWork();

        const deletedAudioMeetingIds = await getMeetingsWithDeletedAudio();
        await markMeetingsAudioDeleted(deletedAudioMeetingIds);
        await enforceAudioRetentionPolicy('startup');
        if (Platform.OS === 'android' && Platform.Version >= 33) {
          await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => null);
        }
        if (Platform.OS === 'android') {
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
          void provisionCoreLanguages().catch((cause) => {
            log.warn('native-speech', 'background language provisioning failed', {
              causeName: cause instanceof Error ? cause.name : typeof cause,
            });
          });
        }
        if (resumedNativeMeetings > 0) {
          log.warn('recovery', 'native post-processing resumed from startup reconciliation', {
            resumedNativeMeetings,
            repaired,
          });
        }
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
    const unregisterNativeScheduler = registerNativePipelineWakeScheduler(scheduleNativePipelineWake);
    let packetPollInFlight: Promise<void> | null = null;
    let stopped = false;
    const packetPollTimer = createEarlierDeadlineTimer({
      onDue: () => { void schedulePacketPoll(); },
    });
    const packetPollSignals = createPacketPollSignalCoalescer({
      isPollInFlight: () => packetPollInFlight !== null,
      appActive: () => AppState.currentState === 'active',
      arm: (delayMs) => packetPollTimer.arm(delayMs),
    });
    const pipelineCoordinator = createPipelineWakeCoordinator({
      requestSignal: requestDurablePipelineWake,
      persistConnectivity: persistPipelineConnectivity,
      runGeneration: (generation) => runDurablePipelineWake({ expectedGeneration: generation }),
      repairNativeScheduling: repairDurablePipelineScheduling,
    });
    let nativeClaimInFlight = false;
    const claimAndRunNativeWake = async () => {
      if (stopped || nativeClaimInFlight) return;
      nativeClaimInFlight = true;
      try {
        const pending = await claimPendingNativePipelineWake();
        if (!pending || stopped) return;
        const outcome = await runNativePipelineWakeTask(pending);
        if (!outcome.succeeded) {
          log.warn('background-pipeline', 'native iOS wake remains deferred', {
            disposition: outcome.disposition,
          });
        }
      } catch (cause) {
        log.warn('background-pipeline', 'native iOS wake claim failed safely', {
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
      } finally {
        nativeClaimInFlight = false;
      }
    };
    const schedulePacketPoll = () => {
      if (stopped || packetPollInFlight) return packetPollInFlight;
      if (packetPollTimer.hasPending()) return Promise.resolve();
      let work: Promise<void>;
      work = reconcilePendingMeetingPackets()
        .then(async (pendingCount) => {
          const nextRetryAt = await getNextMeetingPacketRetryAt();
          const delayMs = nextPacketPollDelay({
            pendingCount,
            appActive: AppState.currentState === 'active',
            nextRetryAt,
          });
          if (stopped || delayMs == null) return;
          packetPollTimer.arm(delayMs);
        })
        .catch((cause) => {
          log.warn('summary', 'pending packet reconciliation failed', { err: String(cause) });
        })
        .finally(() => {
          if (packetPollInFlight !== work) return;
          packetPollInFlight = null;
          if (packetPollSignals.pollSettled()) {
            log.info('summary', 'coalesced packet poll signal retained one successor');
          }
        });
      packetPollInFlight = work;
      return work;
    };
    const runNativeProgressPipeline = () => {
      void pipelineCoordinator.signal('native_progress')
        .then(() => schedulePacketPoll())
        .catch((cause) => {
          log.warn('meetings', 'pipeline reconciliation failed', { err: String(cause) });
        });
    };
    const foregroundStarter = createPipelineForegroundStarter({
      beginForeground: () => pipelineCoordinator.beginSignal('foreground'),
      requestNativeClaim: () => { void claimAndRunNativeWake(); },
      afterCompletion: async () => { await schedulePacketPoll(); },
      onPersistenceError: (cause) => {
        log.warn('meetings', 'foreground pipeline signal could not be persisted', {
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
      },
      onCompletionError: (cause) => {
        log.warn('meetings', 'pipeline reconciliation failed', { err: String(cause) });
      },
    });
    void foregroundStarter.start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void foregroundStarter.start();
    });
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      const connected = state.isConnected === true && state.isInternetReachable !== false;
      void pipelineCoordinator.connectivityChanged(connected)
        .then(() => schedulePacketPoll())
        .catch((cause) => {
          log.warn('background-pipeline', 'connectivity state reconciliation deferred', {
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        });
    });
    const unsubscribeNative = subscribeNativePostProcessingChanges((event) => {
      log.info('recovery', 'native post-processing state changed', {
        meetingId: event.meetingId,
        state: event.state,
      });
      runNativeProgressPipeline();
    });
    const unsubscribeNativeWake = subscribeNativePipelineWakeRequests(() => {
      foregroundStarter.requestNativeClaim();
    });
    const unsubscribePipeline = subscribeMeetingPipelineChanges((meetingId) => {
      const disposition = packetPollSignals.signal();
      log.info('summary', 'meeting pipeline state changed; bounded poll evaluated', {
        meetingId,
        pollInFlight: packetPollInFlight !== null,
        disposition,
      });
    });
    return () => {
      stopped = true;
      foregroundStarter.stop();
      subscription.remove();
      unsubscribeNetwork();
      unsubscribeNative();
      unsubscribeNativeWake();
      unsubscribePipeline();
      unregisterNativeScheduler();
      packetPollSignals.cancel();
      packetPollTimer.cancel();
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const scenario = getIOSAutomationScenario();
    if (scenario === 'record-lifecycle' || scenario === 'record-interrupted' || scenario?.startsWith('record-soak:')) {
      log.info('ios-qualification', 'launching recording scenario', { scenario });
      router.push('/record');
      return;
    }
    if (scenario?.startsWith('cloud-exchange|')) {
      const [, pairingId, verificationCode] = scenario.split('|');
      void (async () => {
        if (!pairingId || !verificationCode) throw new Error('Cloud exchange scenario is malformed.');
        const session = await exchangeMainaCloudPairing({
          pairingId,
          verificationCode,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        const [notes, sources, corrections] = await Promise.all([
          queueEligibleMeetingPackets().catch(() => 0),
          reconcilePendingMainaKnowledgeCloudSyncs().then(() => 0).catch(() => 0),
          reconcilePendingMainaKnowledgeCloudCorrections().then(() => 0).catch(() => 0),
        ]);
        log.info('ios-qualification', 'cloud pairing exchange completed', {
          userId: session.user.userId,
          queuedWork: notes + sources + corrections,
        });
      })().catch((cause) => {
        log.error('ios-qualification', 'cloud pairing exchange failed', {
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
      });
      return;
    }
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
              <Stack.Screen name="notifications" />
              <Stack.Screen name="settings" />
              <Stack.Screen name="help" />
              <Stack.Screen name="diagnostics" />
              <Stack.Screen name="memory" />
              <Stack.Screen name="meeting" />
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
