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
import { completedCaptureDurationRepair } from '@/core/recording/checkpoint';
import { materialCaptureGapError } from '@/core/recording/captureGap';
import { hasCompleteNativeTranscript, terminalNativeMeetingRepair } from '@/core/recording/nativeCaptureReconciliation';
import {
  acknowledgeNativePostProcessingResult,
  getNativeCaptureStatus,
  isNativePostProcessingServiceRunning,
  readNativePostProcessingResult,
  startNativePostProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';
import { TERMINAL_PARTIAL_RECOVERY_ROUNDS } from '@/services/transcriptCoverage';

// Multiple foreground triggers (launch, resume, the meeting screen, and the
// short foreground poll) can arrive together. Serialize them so only one
// Expo-SQLite import ever observes a completed native outbox run at a time.
let nativeReconciliationInFlight: Promise<number> | null = null;

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
    captureEndedAt:
      metrics.stoppedAt
      ?? (metrics.startedAt != null ? metrics.startedAt + metrics.wallDurationMs : null),
    segmentCount: metrics.finalizedUris.length,
    restartCount: metrics.routeRestartCount,
    captureGapMs: metrics.captureGapMs,
    captureDisposition: metrics.captureGapMs > 0 ? 'system_paused' : 'normal',
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
  const nativeStatus = getNativeCaptureStatus();
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
