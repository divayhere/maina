import {
  getMeeting,
  importNativePostProcessingResult,
  listMeetings,
  updateMeeting,
  updateMeetingPipelineStage,
  updateNativePostProcessingProgress,
  type Meeting,
} from '@/data/meetings';
import { completedCaptureDurationRepair } from '@/core/recording/checkpoint';
import {
  acknowledgeNativePostProcessingResult,
  getNativeCaptureStatus,
  readNativePostProcessingResult,
  startNativePostProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';

// Multiple foreground triggers (launch, resume, the meeting screen, and the
// short foreground poll) can arrive together. Serialize them so only one
// Expo-SQLite import ever observes a completed native outbox run at a time.
let nativeReconciliationInFlight: Promise<number> | null = null;

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
    lastError: metrics.captureGapMs > 0 ? `Capture gap detected: ${metrics.captureGapMs}ms` : null,
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
      meeting.status === 'transcribing'
      && (
        meeting.transcriptionWindowCount === 0
        || (meeting.transcriptionCompletedWindows + meeting.transcriptionFailedWindows) < meeting.transcriptionWindowCount
      )
    ) {
      if (await launchNativePostProcessing(meeting)) resumed += 1;
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
