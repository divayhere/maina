import {
  getMeeting,
  getTranscriptSummary,
  importNativePostProcessingResult,
  listMeetings,
  updateMeeting,
  updateMeetingPipelineStage,
  updateNativePostProcessingProgress,
  type Meeting,
} from '@/data/meetings';
import { Platform } from 'react-native';
import { completedCaptureDurationRepair } from '@/core/recording/checkpoint';
import { materialCaptureGapError } from '@/core/recording/captureGap';
import { createKeyedExecutionOwner } from '@/core/pipeline/keyedExecutionOwner';
import { hasCompleteNativeTranscript, terminalNativeMeetingRepair } from '@/core/recording/nativeCaptureReconciliation';
import {
  acknowledgeNativePostProcessingResult,
  beginIOSContinuedProcessing,
  finishIOSContinuedProcessing,
  getNativeCaptureStatusAsync,
  isNativePostProcessingServiceRunning,
  isIOSContinuedProcessingActive,
  readNativePostProcessingResult,
  startNativePostProcessing,
  updateIOSContinuedProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { cleanupTerminalMeetingAudio } from '@/services/audioRetention';
import { notifyMeetingPipelineChanged } from '@/services/meetingPipelineSignals';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';
import { runLocalAsrPipeline } from '@/services/localAsrPipeline';
import { drainMeetingPacketUntilSettled, maybeQueueMeetingPacket } from '@/services/meetingPacket';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import {
  IOS_ASR_MAX_RECOVERY_ROUNDS,
  iosAsrRetryDelayMs,
} from '@/services/iosAsrRecoveryPolicy';
import { isTerminalPartialTranscript } from '@/services/transcriptCoverage';
import { TERMINAL_PARTIAL_RECOVERY_ROUNDS } from '@/services/transcriptCoverage';

// Multiple foreground triggers (launch, resume, the meeting screen, and the
// short foreground poll) can arrive together. Serialize them so only one
// Expo-SQLite import ever observes a completed native outbox run at a time.
let nativeReconciliationInFlight: Promise<number> | null = null;
const iosPostProcessingOwner = createKeyedExecutionOwner<string, boolean>();
const iosPostProcessingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleIOSPostProcessingRetry(meetingId: string, recoveryRounds: number): void {
  const existing = iosPostProcessingRetryTimers.get(meetingId);
  if (existing) clearTimeout(existing);
  const delayMs = iosAsrRetryDelayMs(recoveryRounds);
  if (delayMs == null || delayMs <= 0) {
    iosPostProcessingRetryTimers.delete(meetingId);
    return;
  }
  const timer = setTimeout(() => {
    iosPostProcessingRetryTimers.delete(meetingId);
    void getMeeting(meetingId).then((current) => {
      if (!current?.audioUri || current.status !== 'transcript_partial') return;
      if (current.transcriptionRecoveryRounds !== recoveryRounds) return;
      void launchIOSPostProcessing(current);
    }).catch((cause) => {
      log.warn('recovery', 'iOS delayed transcription retry deferred to durable OS wake', {
        meetingId,
        causeName: cause instanceof Error ? cause.name : typeof cause,
      });
    });
  }, delayMs);
  iosPostProcessingRetryTimers.set(meetingId, timer);
}

/**
 * Foreground callers may intentionally ignore this promise; an OS/background
 * recovery caller awaits the same in-flight promise. That gives one execution
 * owner without blocking React rendering or reporting Worker success early.
 */
async function launchIOSPostProcessing(meeting: Meeting): Promise<boolean> {
  if (!meeting.audioUri) return false;
  return iosPostProcessingOwner.run(meeting.id, async () => {
    await updateMeetingPipelineStage({
      meetingId: meeting.id,
      stage: 'asr',
      state: 'running',
      error: null,
    });
    beginIOSContinuedProcessing(meeting.id, Math.max(1, meeting.transcriptionWindowCount));
    let terminal = false;
    try {
      const runPass = () => runLocalAsrPipeline({
        meetingId: meeting.id,
        directory: meeting.audioUri!,
        meetingStartedAt: meeting.startedAt,
        recoverPartials: true,
        resetTranscript: false,
        onProgress: updateIOSContinuedProcessing,
        isExecutionActive: () => isIOSContinuedProcessingActive(meeting.id),
      });
      const firstResult = await runPass();
      const result = firstResult.coverageComplete ? firstResult : await runPass();
      const recoveryRounds = result.coverageComplete
        ? meeting.transcriptionRecoveryRounds
        : Math.min(IOS_ASR_MAX_RECOVERY_ROUNDS, meeting.transcriptionRecoveryRounds + 1);
      await updateMeeting(meeting.id, { transcriptionRecoveryRounds: recoveryRounds });
      if (result.coverageComplete) {
        const timer = iosPostProcessingRetryTimers.get(meeting.id);
        if (timer) clearTimeout(timer);
        iosPostProcessingRetryTimers.delete(meeting.id);
      } else {
        scheduleIOSPostProcessingRetry(meeting.id, recoveryRounds);
      }
      const refreshedMeeting = await getMeeting(meeting.id);
      const terminalPartial = Boolean(refreshedMeeting && isTerminalPartialTranscript(refreshedMeeting));
      terminal = result.coverageComplete || terminalPartial;
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'asr',
        state: terminal ? 'ready' : 'deferred',
        completedUnits: result.completedWindows,
        totalUnits: result.windowCount,
        error: result.lastError,
        metadata: {
          completedWindows: result.completedWindows,
          failedWindows: result.failedWindows,
          recoveredChunks: result.recoveredChunks,
          executionOwner: 'ios-js-resumable',
          recoveryRounds,
        },
      });
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'transcript_durable',
        state: terminal && result.hasText ? 'ready' : 'deferred',
        completedUnits: result.completedWindows,
        totalUnits: result.windowCount,
        error: result.lastError,
        metadata: { blocks: result.blockCount, words: result.wordCount },
      });
      if (terminal && result.hasText) {
        await maybeQueueMeetingPacket(meeting.id).catch((cause) => {
          log.warn('summary', 'iOS packet queue remains durable', {
            meetingId: meeting.id,
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        });
        await drainMeetingPacketUntilSettled(meeting.id).catch((cause) => {
          log.warn('summary', 'iOS bounded packet drain deferred', {
            meetingId: meeting.id,
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        });
        await reconcilePendingMainaKnowledgeCloudSyncs().catch((cause) => {
          log.warn('maina-cloud', 'iOS bounded source drain deferred', {
            meetingId: meeting.id,
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        });
        if (result.coverageComplete) await cleanupTerminalMeetingAudio(meeting.id);
      }
      notifyMeetingPipelineChanged(meeting.id);
      log.info('recovery', 'iOS local post-processing reached durable boundary', {
        meetingId: meeting.id,
        terminal,
        coverageComplete: result.coverageComplete,
        completedWindows: result.completedWindows,
        failedWindows: result.failedWindows,
      });
      return terminal;
    } catch (cause) {
      const safeError = 'Local transcription paused safely. Maina will continue automatically.';
      await updateMeeting(meeting.id, { status: 'transcribing', lastError: safeError });
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'asr',
        state: 'deferred',
        error: safeError,
      });
      log.error('recovery', 'iOS local post-processing deferred', {
        meetingId: meeting.id,
        causeName: cause instanceof Error ? cause.name : typeof cause,
      });
      return false;
    } finally {
      finishIOSContinuedProcessing(terminal);
    }
  });
}

/**
 * A native-result Worker is only a wake signal. The native outbox remains the
 * durable truth, so stale WorkManager deliveries must validate the exact run
 * before they are allowed to create a shared pipeline generation.
 */
export async function isCurrentNativePostProcessingWake(
  meetingId: string,
  runId: string,
): Promise<boolean> {
  if (!meetingId || !runId) return false;
  const result = await readNativePostProcessingResult(meetingId);
  return result?.meetingId === meetingId
    && result.runId === runId
    && ['complete', 'partial', 'deferred'].includes(result.state);
}

async function launchNativePostProcessing(
  meeting: Meeting,
  options: { forceRetry?: boolean } = {},
) {
  if (!meeting.audioUri) return false;
  const metrics = await getNativeCaptureMetrics(meeting.audioUri, true);
  if (metrics.finalizedUris.length === 0) {
    const error = metrics.partialUris.length > 0
      ? 'Audio finalization is still incomplete; recovery audio was preserved.'
      : 'Native capture produced no finalized WAV chunks.';
    await updateMeeting(meeting.id, {
      status: 'interrupted',
      lastError: error,
    });
    await updateMeetingPipelineStage({ meetingId: meeting.id, stage: 'audio_finalized', state: 'failed', error });
    return false;
  }
  await updateMeeting(meeting.id, {
    // User-facing meeting length is recorded audio, never wall time spent in
    // a call/interruption. Keep the excluded interval as captureGapMs.
    durationMs: metrics.audioDurationMs > 0 ? metrics.audioDurationMs : meeting.durationMs,
    audioDurationMs: metrics.audioDurationMs,
    captureEndedAt: metrics.stoppedAt ?? meeting.captureEndedAt ?? null,
    segmentCount: metrics.finalizedUris.length,
    restartCount: metrics.routeRestartCount,
    captureGapMs: metrics.captureGapMs,
    captureDisposition: meeting.status === 'recording'
      ? 'partial_capture_failure'
      : meeting.captureDisposition ?? 'complete',
    status: 'transcribing',
    lastError: materialCaptureGapError(metrics.captureGapMs),
  });
  await updateMeetingPipelineStage({
    meetingId: meeting.id,
    stage: 'recording',
    state: 'ready',
    completedUnits: 1,
    totalUnits: 1,
    error: null,
  });
  await updateMeetingPipelineStage({
    meetingId: meeting.id,
    stage: 'audio_finalized',
    state: 'ready',
    completedUnits: metrics.finalizedUris.length,
    totalUnits: metrics.finalizedUris.length,
    error: null,
    metadata: {
      audioDurationMs: metrics.audioDurationMs,
      captureGapMs: metrics.captureGapMs,
      routeRestartCount: metrics.routeRestartCount,
    },
  });
  await updateMeetingPipelineStage({ meetingId: meeting.id, stage: 'asr', state: 'queued', error: null });
  if (Platform.OS === 'ios') {
    const completed = await launchIOSPostProcessing(meeting);
    if (!completed) {
      log.warn('recovery', 'iOS post-processing remains durably deferred', { meetingId: meeting.id });
    }
    return completed;
  }
  try {
    await startNativePostProcessing({
      meetingId: meeting.id,
      directory: meeting.audioUri,
      forceRetry: options.forceRetry,
      meetingStartedAt: meeting.startedAt,
      captureEndedAt: metrics.stoppedAt ?? undefined,
      wallDurationMs: metrics.wallDurationMs,
      audioDurationMs: metrics.audioDurationMs,
      routeRestartCount: metrics.routeRestartCount,
      captureGapMs: metrics.captureGapMs,
    });
    await updateMeetingPipelineStage({
      meetingId: meeting.id,
      stage: 'asr',
      state: 'running',
      error: null,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await updateMeeting(meeting.id, {
      status: 'transcribing',
      lastError: `Native post-processing could not start yet: ${message}`,
    });
    await updateMeetingPipelineStage({
      meetingId: meeting.id,
      stage: 'asr',
      state: 'deferred',
      error: `Native post-processing could not start yet: ${message}`,
    });
    log.error('recovery', 'native post-processing launch failed', {
      meetingId: meeting.id,
      err: message,
    });
    return false;
  }
  log.warn('recovery', 'native post-processing resumed from durable audio', {
    meetingId: meeting.id,
    chunks: metrics.finalizedUris.length,
    audioDurationMs: metrics.audioDurationMs,
    wallDurationMs: metrics.wallDurationMs,
  });
  return true;
}

async function reconcilePendingNativeMeetingWorkInternal(): Promise<number> {
  const nativeStatus = await getNativeCaptureStatusAsync().catch(() => null);
  // The native outbox heartbeat is durable, so it can still look active for
  // up to two minutes after Android kills the isolated ASR process. Trust that
  // heartbeat only while Maina's own post-processing service actually exists.
  // This makes foreground recovery immediate without starting duplicate ASR.
  const nativePostProcessingServiceRunning = isNativePostProcessingServiceRunning();
  const meetings = await listMeetings();
  let resumed = 0;

  for (const meeting of meetings) {
    const nativeResult = await readNativePostProcessingResult(meeting.id).catch((cause) => {
      log.warn('recovery', 'native post-processing outbox read failed', {
        meetingId: meeting.id,
        err: String(cause),
      });
      return null;
    });
    if (nativeResult?.state === 'complete' || nativeResult?.state === 'partial') {
      const terminalPartial = nativeResult.state === 'partial'
        && nativeResult.windowCount > 0
        && nativeResult.completedWindows + nativeResult.failedWindows >= nativeResult.windowCount
        && nativeResult.completedWindows > 0
        && nativeResult.recoveryRounds >= TERMINAL_PARTIAL_RECOVERY_ROUNDS;
      // A service-owned stop can complete while React Native is absent (for
      // example after bounded call-resume exhaustion). If the meeting row is
      // still `recording`, preserve truthful partial-capture ownership before
      // importing the otherwise usable transcript.
      if (meeting.status === 'recording') {
        await updateMeeting(meeting.id, {
          captureDisposition: nativeResult.captureGapMs > 0
            ? 'partial_system_interruption'
            : 'partial_capture_failure',
          capturePauseReason: nativeResult.captureGapMs > 0 ? 'system' : null,
        });
      }
      const imported = await importNativePostProcessingResult({
        meetingId: nativeResult.meetingId,
        runId: nativeResult.runId,
        captureEndedAt: nativeResult.captureEndedAt,
        durationMs: nativeResult.durationMs,
        audioDurationMs: nativeResult.audioDurationMs,
        segmentCount: nativeResult.segmentCount,
        processedSegments: nativeResult.processedSegments,
        windowCount: nativeResult.windowCount,
        completedWindows: nativeResult.completedWindows,
        failedWindows: nativeResult.failedWindows,
        recoveryRounds: nativeResult.recoveryRounds,
        routeRestartCount: nativeResult.routeRestartCount,
        lastError: nativeResult.lastError,
        captureTerminal: nativeResult.state === 'complete' || terminalPartial,
        blocks: nativeResult.blocks,
      });
      // Preserve native per-window evidence for a partial transcript. A later
      // retry can then decode only the failed interval rather than replaying
      // the whole meeting. Complete results remain safe to acknowledge/delete.
      const acknowledged = nativeResult.state === 'complete'
        ? await acknowledgeNativePostProcessingResult(
          nativeResult.meetingId,
          nativeResult.runId,
        ).catch((cause) => {
        // The Expo transaction has committed. Leaving the native result intact
        // is safe: a later retry is idempotent and will attempt acknowledgement
        // again rather than ever losing the recording's transcription.
        log.warn('recovery', 'native post-processing outbox acknowledgement failed', {
          meetingId: meeting.id,
          runId: nativeResult.runId,
          err: String(cause),
        });
          return false;
        })
        : false;
      await updateMeetingPipelineStage({
        meetingId: nativeResult.meetingId,
        stage: 'asr',
        state: nativeResult.state === 'complete' || terminalPartial ? 'ready' : 'deferred',
        completedUnits: nativeResult.completedWindows + nativeResult.failedWindows,
        totalUnits: nativeResult.windowCount,
        error: nativeResult.lastError,
        metadata: {
          runId: nativeResult.runId,
          processedSegments: nativeResult.processedSegments,
          failedWindows: nativeResult.failedWindows,
          partialCoverage: nativeResult.state === 'partial',
          recoveryRounds: nativeResult.recoveryRounds,
        },
      });
      await updateMeetingPipelineStage({
        meetingId: nativeResult.meetingId,
        stage: 'transcript_durable',
        state: nativeResult.state === 'complete' || terminalPartial ? 'ready' : 'deferred',
        completedUnits: nativeResult.completedWindows,
        totalUnits: nativeResult.windowCount,
        error: nativeResult.lastError,
        metadata: {
          runId: nativeResult.runId,
          blocks: nativeResult.blocks.length,
          partialCoverage: nativeResult.state === 'partial',
          recoveryRounds: nativeResult.recoveryRounds,
        },
      });
      log.info('recovery', 'native post-processing outbox reconciled', {
        meetingId: meeting.id,
        runId: nativeResult.runId,
        imported,
        acknowledged,
        blocks: nativeResult.blocks.length,
      });
      if (nativeResult.state === 'complete') {
        await cleanupTerminalMeetingAudio(nativeResult.meetingId);
      }
      notifyMeetingPipelineChanged(nativeResult.meetingId);
      continue;
    }
    if (nativeResult) {
      await updateNativePostProcessingProgress({
        meetingId: nativeResult.meetingId,
        windowCount: nativeResult.windowCount,
        completedWindows: nativeResult.completedWindows,
        failedWindows: nativeResult.failedWindows,
        recoveryRounds: nativeResult.recoveryRounds,
        processedSegments: nativeResult.processedSegments,
        lastError: nativeResult.state === 'deferred' ? nativeResult.lastError : null,
      });
      await updateMeetingPipelineStage({
        meetingId: nativeResult.meetingId,
        stage: 'asr',
        state: nativeResult.state === 'deferred' ? 'deferred' : 'running',
        completedUnits: nativeResult.completedWindows + nativeResult.failedWindows,
        totalUnits: nativeResult.windowCount,
        error: nativeResult.state === 'deferred' ? nativeResult.lastError : null,
        metadata: {
          runId: nativeResult.runId,
          processedSegments: nativeResult.processedSegments,
          failedWindows: nativeResult.failedWindows,
        },
      });
      notifyMeetingPipelineChanged(nativeResult.meetingId);
    }
    // Window counters alone are not transcript proof: native ASR can finish
    // before its outbox is imported into Expo SQLite. Repair an old terminal
    // label only after the actual text is confirmed durable in this database.
    const transcriptSummary = hasCompleteNativeTranscript(meeting)
      ? await getTranscriptSummary(meeting.id)
      : null;
    const terminalRepair = terminalNativeMeetingRepair({
      ...meeting,
      hasTranscriptText: transcriptSummary?.hasText ?? false,
    });
    if (terminalRepair) {
      await updateMeeting(meeting.id, terminalRepair);
      log.warn('recovery', 'repaired terminal meeting state after completed audio cleanup', {
        meetingId: meeting.id,
        restoredStatus: terminalRepair.status,
        restoredDurationMs: terminalRepair.durationMs,
      });
      continue;
    }

    const repairedDurationMs = completedCaptureDurationRepair(meeting);
    if (repairedDurationMs != null) {
      await updateMeeting(meeting.id, { durationMs: repairedDurationMs });
      log.warn('recovery', 'repaired duration from durable capture boundary', {
        meetingId: meeting.id,
        previousDurationMs: meeting.durationMs,
        repairedDurationMs,
      });
    }

    const isLiveNativeMeeting = nativeStatus?.meetingId === meeting.id
      && nativeStatus.state !== 'idle'
      && nativeStatus.state !== 'error';
    if (isLiveNativeMeeting) continue;
    if (nativeResult?.active && nativePostProcessingServiceRunning) continue;
    if (!meeting.audioUri) continue;

    if (meeting.status === 'recording') {
      if (await launchNativePostProcessing(meeting)) resumed += 1;
      continue;
    }

    if (
      (meeting.status === 'transcribing' || meeting.status === 'transcript_partial')
      && (
        meeting.transcriptionWindowCount === 0
        || (meeting.transcriptionCompletedWindows + meeting.transcriptionFailedWindows) < meeting.transcriptionWindowCount
        || (meeting.status === 'transcript_partial'
          && meeting.transcriptionRecoveryRounds < TERMINAL_PARTIAL_RECOVERY_ROUNDS)
      )
    ) {
      if (await launchNativePostProcessing(meeting, { forceRetry: meeting.status === 'transcript_partial' })) resumed += 1;
    }
  }

  return resumed;
}

export function reconcilePendingNativeMeetingWork(): Promise<number> {
  if (nativeReconciliationInFlight) return nativeReconciliationInFlight;
  let work: Promise<number>;
  work = reconcilePendingNativeMeetingWorkInternal().finally(() => {
    if (nativeReconciliationInFlight === work) nativeReconciliationInFlight = null;
  });
  nativeReconciliationInFlight = work;
  return work;
}

export async function hydrateMeetingFromDurableCapture(meetingId: string): Promise<Meeting | null> {
  const meeting = await getMeeting(meetingId);
  if (!meeting?.audioUri) return meeting;
  if (meeting.status !== 'recording') return meeting;
  await launchNativePostProcessing(meeting);
  return getMeeting(meetingId);
}

export async function retryNativeMeetingTranscription(meetingId: string): Promise<boolean> {
  const meeting = await getMeeting(meetingId);
  if (!meeting?.audioUri) return false;
  return launchNativePostProcessing(meeting, { forceRetry: true });
}
