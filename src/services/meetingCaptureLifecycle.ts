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
import {
  hasCompleteNativeTranscript,
  hasInterruptedNativeAsrCheckpoint,
  terminalNativeMeetingRepair,
} from '@/core/recording/nativeCaptureReconciliation';
import {
  acknowledgeNativePostProcessingResult,
  beginIOSContinuedProcessing,
  finishIOSContinuedProcessing,
  getNativeCaptureStatusAsync,
  readNativePostProcessingResult,
  startNativePostProcessing,
  updateIOSContinuedProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';
import { runLocalAsrPipeline } from '@/services/localAsrPipeline';
import { drainMeetingPacketUntilSettled, maybeQueueMeetingPacket } from '@/services/meetingPacket';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { enforceAudioRetentionPolicy } from '@/services/audioRetention';
import {
  IOS_ASR_MAX_RECOVERY_ROUNDS,
  iosAsrRetryDelayMs,
  isIOSAsrRetryDue,
} from '@/services/iosAsrRecoveryPolicy';
import { isTerminalPartialTranscript } from '@/services/transcriptCoverage';

// Multiple foreground triggers (launch, resume, the meeting screen, and the
// short foreground poll) can arrive together. Serialize them so only one
// Expo-SQLite import ever observes a completed native outbox run at a time.
let nativeReconciliationInFlight: Promise<number> | null = null;
const iosPostProcessingInFlight = new Map<string, Promise<void>>();
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
      log.warn('recovery', 'iOS delayed transcription retry deferred until foreground', {
        meetingId,
        err: String(cause),
      });
    });
  }, delayMs);
  iosPostProcessingRetryTimers.set(meetingId, timer);
}

async function launchIOSPostProcessing(meeting: Meeting): Promise<boolean> {
  if (!meeting.audioUri) return false;
  const captureDirectory = meeting.audioUri;
  if (iosPostProcessingInFlight.has(meeting.id)) return true;

  await updateMeetingPipelineStage({
    meetingId: meeting.id,
    stage: 'asr',
    state: 'running',
    error: null,
  });
  beginIOSContinuedProcessing(meeting.id, Math.max(1, meeting.transcriptionWindowCount));
  let passCompleted = false;
  const runPass = () => runLocalAsrPipeline({
    meetingId: meeting.id,
    directory: captureDirectory,
    meetingStartedAt: meeting.startedAt,
    recoverPartials: true,
    // Completed Qwen windows are transactionally checkpointed. Relaunch skips
    // them and resumes only unfinished intervals rather than replaying hours.
    resetTranscript: false,
    onProgress: updateIOSContinuedProcessing,
  });
  const work = runPass()
    .then(async (firstResult) => {
      // Checkpoints make this a failed-window retry, not a second full pass.
      if (firstResult.coverageComplete) return firstResult;
      return runPass();
    })
    .then(async (result) => {
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
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'asr',
        state: result.coverageComplete ? 'ready' : 'deferred',
        completedUnits: result.completedWindows,
        totalUnits: result.windowCount,
        error: result.lastError,
        metadata: {
          completedWindows: result.completedWindows,
          failedWindows: result.failedWindows,
          recoveredChunks: result.recoveredChunks,
          executionOwner: 'ios-js-resumable-fallback',
          recoveryRounds,
        },
      });
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'transcript_durable',
        state: result.coverageComplete && result.hasText ? 'ready' : 'deferred',
        completedUnits: result.completedWindows,
        totalUnits: result.windowCount,
        error: result.lastError,
        metadata: { blocks: result.blockCount, words: result.wordCount },
      });
      const refreshedMeeting = await getMeeting(meeting.id);
      const usableTranscript = result.coverageComplete && result.hasText
        || Boolean(refreshedMeeting && isTerminalPartialTranscript(refreshedMeeting));
      if (usableTranscript) {
        await maybeQueueMeetingPacket(meeting.id).catch((cause) => {
          log.warn('summary', 'iOS post-call packet queue deferred', {
            meetingId: meeting.id,
            err: String(cause),
          });
        });
        // A user-initiated iOS continued-processing task should carry the
        // resulting short cloud handoff too. Bound this to one minute; longer
        // server work remains in the durable retry queue for an OS wake.
        await drainMeetingPacketUntilSettled(meeting.id).catch((cause) => {
          log.warn('summary', 'iOS bounded packet drain deferred', {
            meetingId: meeting.id,
            err: String(cause),
          });
        });
        await reconcilePendingMainaKnowledgeCloudSyncs().catch((cause) => {
          log.warn('maina-cloud', 'iOS bounded source drain deferred', {
            meetingId: meeting.id,
            err: String(cause),
          });
        });
        await enforceAudioRetentionPolicy().catch((cause) => {
          log.warn('audio-retention', 'iOS completed-audio cleanup deferred', {
            meetingId: meeting.id,
            err: String(cause),
          });
        });
      }
      log.info('recovery', 'iOS local post-processing finished', {
        meetingId: meeting.id,
        coverageComplete: result.coverageComplete,
        completedWindows: result.completedWindows,
        failedWindows: result.failedWindows,
        words: result.wordCount,
      });
      passCompleted = true;
    })
    .catch(async (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      await updateMeeting(meeting.id, {
        status: 'transcribing',
        lastError: `Local transcription paused safely: ${message}`,
      });
      await updateMeetingPipelineStage({
        meetingId: meeting.id,
        stage: 'asr',
        state: 'deferred',
        error: `Local transcription paused safely: ${message}`,
      });
      log.error('recovery', 'iOS local post-processing deferred', {
        meetingId: meeting.id,
        err: message,
      });
    })
    .finally(() => {
      finishIOSContinuedProcessing(passCompleted);
      iosPostProcessingInFlight.delete(meeting.id);
    });
  iosPostProcessingInFlight.set(meeting.id, work);
  void work;
  return true;
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
    durationMs: metrics.wallDurationMs,
    audioDurationMs: metrics.audioDurationMs,
    captureEndedAt:
      metrics.stoppedAt
      ?? (metrics.startedAt != null ? metrics.startedAt + metrics.wallDurationMs : null),
    segmentCount: metrics.finalizedUris.length,
    restartCount: metrics.routeRestartCount,
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
    const launched = await launchIOSPostProcessing(meeting);
    if (launched) {
      log.warn('recovery', 'iOS post-processing resumed from durable audio', {
        meetingId: meeting.id,
        chunks: metrics.finalizedUris.length,
        audioDurationMs: metrics.audioDurationMs,
        wallDurationMs: metrics.wallDurationMs,
      });
    }
    return launched;
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
        routeRestartCount: nativeResult.routeRestartCount,
        lastError: nativeResult.lastError,
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
        state: nativeResult.state === 'complete' ? 'ready' : 'failed',
        completedUnits: nativeResult.completedWindows + nativeResult.failedWindows,
        totalUnits: nativeResult.windowCount,
        error: nativeResult.lastError,
        metadata: {
          runId: nativeResult.runId,
          processedSegments: nativeResult.processedSegments,
          failedWindows: nativeResult.failedWindows,
        },
      });
      await updateMeetingPipelineStage({
        meetingId: nativeResult.meetingId,
        stage: 'transcript_durable',
        state: nativeResult.state === 'complete' ? 'ready' : 'failed',
        completedUnits: nativeResult.completedWindows,
        totalUnits: nativeResult.windowCount,
        error: nativeResult.lastError,
        metadata: { runId: nativeResult.runId, blocks: nativeResult.blocks.length },
      });
      log.info('recovery', 'native post-processing outbox reconciled', {
        meetingId: meeting.id,
        runId: nativeResult.runId,
        imported,
        acknowledged,
        blocks: nativeResult.blocks.length,
      });
      continue;
    }
    if (nativeResult) {
      await updateNativePostProcessingProgress({
        meetingId: nativeResult.meetingId,
        windowCount: nativeResult.windowCount,
        completedWindows: nativeResult.completedWindows,
        failedWindows: nativeResult.failedWindows,
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
    if (nativeResult?.active) continue;
    if (!meeting.audioUri) continue;

    if (meeting.status === 'recording') {
      if (await launchNativePostProcessing(meeting)) resumed += 1;
      continue;
    }

    if (
      (
        meeting.status === 'transcribing'
        || meeting.status === 'transcript_partial'
        || hasInterruptedNativeAsrCheckpoint(meeting)
      )
      && (
        meeting.transcriptionWindowCount === 0
        || (meeting.transcriptionCompletedWindows + meeting.transcriptionFailedWindows) < meeting.transcriptionWindowCount
        || (
          meeting.status === 'transcript_partial'
          && meeting.transcriptionRecoveryRounds < IOS_ASR_MAX_RECOVERY_ROUNDS
          && isIOSAsrRetryDue({
            recoveryRounds: meeting.transcriptionRecoveryRounds,
            updatedAt: meeting.updatedAt,
            now: Date.now(),
          })
        )
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
