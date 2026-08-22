import {
  getMeeting,
  importNativePostProcessingResult,
  listMeetings,
  updateMeeting,
  type Meeting,
} from '@/data/meetings';
import { completedCaptureDurationRepair } from '@/core/recording/checkpoint';
import {
  getNativeCaptureStatus,
  readNativePostProcessingResult,
  startNativePostProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';

async function launchNativePostProcessing(meeting: Meeting) {
  if (!meeting.audioUri) return false;
  const metrics = await getNativeCaptureMetrics(meeting.audioUri, true);
  if (metrics.finalizedUris.length === 0) {
    await updateMeeting(meeting.id, {
      status: 'interrupted',
      lastError: metrics.partialUris.length > 0
        ? 'Audio finalization is still incomplete; recovery audio was preserved.'
        : 'Native capture produced no finalized WAV chunks.',
    });
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
  try {
    await startNativePostProcessing({
      meetingId: meeting.id,
      directory: meeting.audioUri,
      meetingStartedAt: meeting.startedAt,
      captureEndedAt: metrics.stoppedAt ?? undefined,
      wallDurationMs: metrics.wallDurationMs,
      audioDurationMs: metrics.audioDurationMs,
      routeRestartCount: metrics.routeRestartCount,
      captureGapMs: metrics.captureGapMs,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await updateMeeting(meeting.id, {
      status: 'transcribing',
      lastError: `Native post-processing could not start yet: ${message}`,
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

export async function reconcilePendingNativeMeetingWork(): Promise<number> {
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
    if (nativeResult?.state === 'complete') {
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
      log.info('recovery', 'native post-processing outbox reconciled', {
        meetingId: meeting.id,
        runId: nativeResult.runId,
        imported,
        blocks: nativeResult.blocks.length,
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

export async function hydrateMeetingFromDurableCapture(meetingId: string): Promise<Meeting | null> {
  const meeting = await getMeeting(meetingId);
  if (!meeting?.audioUri) return meeting;
  if (meeting.status !== 'recording') return meeting;
  await launchNativePostProcessing(meeting);
  return getMeeting(meetingId);
}
