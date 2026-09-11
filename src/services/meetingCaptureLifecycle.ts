import {
  getMeeting,
  getMeetingPipelineStages,
  getTranscriptSummary,
  importIOSNativePostProcessingResult,
  importNativePostProcessingResult,
  listMeetings,
  markIOSNativePostProcessingRunningIfUnimported,
  updateMeeting,
  updateMeetingPipelineStage,
  updateNativePostProcessingProgress,
  type Meeting,
} from '@/data/meetings';
import { Platform } from 'react-native';
import { completedCaptureDurationRepair } from '@/core/recording/checkpoint';
import { materialCaptureGapError } from '@/core/recording/captureGap';
import { createKeyedExecutionOwner } from '@/core/pipeline/keyedExecutionOwner';
import {
  createIOSContinuedProcessingDeferralHandler,
  type IOSContinuedProcessingHandleState,
} from '@/core/transcription/asr/iosContinuedProcessingPolicy';
import { hasCompleteNativeTranscript, terminalNativeMeetingRepair } from '@/core/recording/nativeCaptureReconciliation';
import {
  acknowledgeNativePostProcessingResult,
  acknowledgeIOSNativePostProcessingResult,
  acknowledgeIOSContinuedProcessingDeferral,
  beginIOSContinuedProcessing,
  bindIOSContinuedProcessingRun,
  finishIOSContinuedProcessing,
  getNativeCaptureStatusAsync,
  isNativePostProcessingServiceRunning,
  prepareIOSNativePostProcessingAudio,
  readIOSNativePostProcessingResult,
  readNativePostProcessingResult,
  releaseIOSNativePostProcessingAsr,
  startIOSNativePostProcessing,
  startNativePostProcessing,
  subscribeIOSPostProcessingDeferralRequests,
  updateIOSContinuedProcessing,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { cleanupTerminalMeetingAudio } from '@/services/audioRetention';
import { notifyMeetingPipelineChanged } from '@/services/meetingPipelineSignals';
import { getNativeCaptureMetrics } from '@/services/nativeCaptureMetrics';
import { readNativeCaptureAutomaticWorkFence } from '@/services/nativeCaptureQuarantineFence';
import { drainMeetingPacketUntilSettled, maybeQueueMeetingPacket } from '@/services/meetingPacket';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import {
  buildIOSNativePostProcessingImportFence,
  buildIOSNativePostProcessingStartRequest,
  deriveIOSNativePostProcessingExecutionIdentity,
  nativeProgress,
  type IOSNativePostProcessingExecutionIdentity,
} from '@/services/nativePostProcessingCore';
import { getMainaCloudSession } from '@/services/mainaCloudSession';
import { TERMINAL_PARTIAL_RECOVERY_ROUNDS } from '@/services/transcriptCoverage';

// Multiple foreground triggers (launch, resume, the meeting screen, and the
// short foreground poll) can arrive together. Serialize them so only one
// Expo-SQLite import ever observes a completed native outbox run at a time.
let nativeReconciliationInFlight: Promise<number> | null = null;
const iosPostProcessingOwner = createKeyedExecutionOwner<string, boolean>();
type IOSPostProcessingHandle = IOSContinuedProcessingHandleState & {
  runtimeOwnerToken: string;
};
const iosPostProcessingHandles = new Map<string, IOSPostProcessingHandle>();
const iosPostProcessingHandleByMeeting = new Map<string, string>();

const handleIOSPostProcessingDeferral = createIOSContinuedProcessingDeferralHandler({
  fenceGeneration: (event) => {
    const handle = iosPostProcessingHandles.get(event.requestId);
    if (!handle || handle.meetingId !== event.meetingId
      || handle.asrGeneration !== event.asrGeneration) return Promise.resolve(false);
    return releaseIOSNativePostProcessingAsr(
      handle.runtimeOwnerToken,
      event.asrGeneration,
    );
  },
  markStageDeferred: (event) => updateMeetingPipelineStage({
    meetingId: event.meetingId,
    stage: 'asr',
    state: 'deferred',
    error: 'Local transcription paused safely. Maina will continue automatically.',
    metadata: {
      executionOwner: 'ios-native-durable',
      asrGeneration: event.asrGeneration,
      deferredBy: 'ios-continued-processing-expiration',
    },
  }).then(() => undefined),
  acknowledge: (event) => {
    acknowledgeIOSContinuedProcessingDeferral(event.requestId, event.meetingId, event.asrGeneration);
  },
  onFenceError: (cause) => {
    log.warn('recovery', 'iOS ASR expiration fence was not persisted', {
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
  },
  onStageError: (cause) => {
    log.warn('recovery', 'iOS ASR deferred stage awaits reconciliation', {
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
  },
});

function removeIOSPostProcessingHandle(handle: IOSPostProcessingHandle, success: boolean): void {
  if (iosPostProcessingHandles.get(handle.requestId) !== handle) return;
  iosPostProcessingHandles.delete(handle.requestId);
  if (iosPostProcessingHandleByMeeting.get(handle.meetingId) === handle.requestId) {
    iosPostProcessingHandleByMeeting.delete(handle.meetingId);
  }
  finishIOSContinuedProcessing(handle.requestId, success);
}

// Native expiration releases only the exact recognizer claim. The WAL,
// immutable audio, checkpoints, and any terminal result remain available for
// the next public wake; the callback cannot carry result authority.
subscribeIOSPostProcessingDeferralRequests((event) => {
  const handle = iosPostProcessingHandles.get(event.requestId);
  void handleIOSPostProcessingDeferral(handle, event).then((disposition) => {
    if (handle && disposition !== 'identity_mismatch') {
      // acknowledgeIOSContinuedProcessingDeferral already balances the OS
      // task. Remove only the JS registry entry without completing it twice.
      iosPostProcessingHandles.delete(handle.requestId);
      if (iosPostProcessingHandleByMeeting.get(handle.meetingId) === handle.requestId) {
        iosPostProcessingHandleByMeeting.delete(handle.meetingId);
      }
    }
  });
});

function activeIOSPostProcessingHandle(meetingId: string): IOSPostProcessingHandle | null {
  const requestId = iosPostProcessingHandleByMeeting.get(meetingId);
  if (!requestId) return null;
  return iosPostProcessingHandles.get(requestId) ?? null;
}

async function repairIOSImportedPostProcessingStages(
  meeting: Meeting,
  identity: IOSNativePostProcessingExecutionIdentity,
): Promise<boolean> {
  if (meeting.nativePostprocessRunId !== identity.runId
    || !Number.isSafeInteger(meeting.nativePostprocessImportedAt)
    || (meeting.nativePostprocessImportedAt ?? 0) <= 0) return false;
  const [stages, transcriptSummary] = await Promise.all([
    getMeetingPipelineStages(meeting.id),
    getTranscriptSummary(meeting.id),
  ]);
  const hasText = transcriptSummary?.hasText ?? false;
  const completedUnits = Math.max(
    0,
    meeting.transcriptionCompletedWindows + meeting.transcriptionFailedWindows,
  );
  const totalUnits = Math.max(completedUnits, meeting.transcriptionWindowCount);
  const asr = stages.find((stage) => stage.stage === 'asr');
  let repaired = false;
  if (asr?.state !== 'ready') {
    await updateMeetingPipelineStage({
      meetingId: meeting.id,
      stage: 'asr',
      state: 'ready',
      completedUnits,
      totalUnits,
      error: meeting.transcriptionFailedWindows > 0
        ? 'Some audio could not be transcribed. The audio was kept for recovery.'
        : null,
    });
    repaired = true;
  }
  const transcript = stages.find((stage) => stage.stage === 'transcript_durable');
  const transcriptState = hasText ? 'ready' : 'failed';
  if (transcript?.state !== transcriptState) {
    await updateMeetingPipelineStage({
      meetingId: meeting.id,
      stage: 'transcript_durable',
      state: transcriptState,
      completedUnits: meeting.transcriptionCompletedWindows,
      totalUnits,
      error: hasText ? null : 'Local transcription produced no text. The audio was kept for recovery.',
    });
    repaired = true;
  }
  if (repaired) notifyMeetingPipelineChanged(meeting.id);
  return true;
}

async function finishIOSNativePostProcessingResult(
  meeting: Meeting,
  identity: IOSNativePostProcessingExecutionIdentity,
): Promise<'absent' | 'read_unavailable' | 'retained' | 'acknowledged'> {
  let result;
  try {
    // The native decoder is deliberately closed. Do not pass the wider
    // execution identity here: runtimeOwnerToken is start/release authority
    // and an extra key makes the exact Swift read decoder reject the request.
    result = await readIOSNativePostProcessingResult({
      ownerUserId: identity.ownerUserId,
      meetingId: identity.meetingId,
      runId: identity.runId,
      generation: identity.generation,
    });
  } catch (cause) {
    // A read failure is not evidence that terminal native work exists. The
    // subsequent start boundary is owner/run/fingerprint idempotent, so it can
    // safely reopen or resume the exact durable run without creating another
    // generation. Keeping this distinct from import/acknowledgement failure
    // prevents a transient bridge/store read from stranding a recording row.
    log.warn('recovery', 'iOS native result read unavailable; exact run will reconcile idempotently', {
      meetingId: meeting.id,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
    return 'read_unavailable';
  }
  if (!result) return 'absent';

  const durableImport = await importIOSNativePostProcessingResult(result);
  if (!durableImport) return 'retained';
  const fence = buildIOSNativePostProcessingImportFence(result, durableImport);
  const acknowledged = await acknowledgeIOSNativePostProcessingResult(fence).catch((cause) => {
    log.warn('recovery', 'iOS native result acknowledgement remains durable', {
      meetingId: meeting.id,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
    return false;
  });
  if (!acknowledged) {
    // `false` is a truthful native CAS rejection, not a thrown bridge error.
    // Publish one bounded reason so later reconciliation can be distinguished
    // from a successfully cleared native payload without exposing result data.
    log.warn('recovery', 'iOS native acknowledgement is pending exact reconciliation', {
      reasonCode: 'native_acknowledgement_not_applied',
      disposition: result.disposition,
    });
  }
  const progress = nativeProgress(result.coverage);
  const hasText = result.windows.some((window) => window.blocks.length > 0);
  await updateMeetingPipelineStage({
    meetingId: meeting.id,
    stage: 'asr',
    state: 'ready',
    completedUnits: progress.completed,
    totalUnits: progress.total,
    error: result.disposition === 'partial'
      ? 'Some audio could not be transcribed. The audio was kept for recovery.'
      : null,
    metadata: {
      runId: result.identity.runId,
      executionOwner: 'ios-native-durable',
      partialCoverage: result.disposition === 'partial',
      failedWindows: result.coverage.failedWindows,
    },
  });
  await updateMeetingPipelineStage({
    meetingId: meeting.id,
    stage: 'transcript_durable',
    state: hasText ? 'ready' : 'failed',
    completedUnits: result.coverage.completedWindows,
    totalUnits: result.coverage.windowCount,
    error: hasText ? null : 'Local transcription produced no text. The audio was kept for recovery.',
    metadata: {
      runId: result.identity.runId,
      blocks: result.windows.reduce((sum, window) => sum + window.blocks.length, 0),
      partialCoverage: result.disposition === 'partial',
    },
  });

  const handle = activeIOSPostProcessingHandle(meeting.id);
  if (handle) {
    updateIOSContinuedProcessing(handle.requestId, progress.completed, progress.total);
    removeIOSPostProcessingHandle(handle, true);
  }
  if (hasText) {
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
  }
  if (acknowledged && result.disposition === 'complete') {
    await cleanupTerminalMeetingAudio(meeting.id);
  }
  notifyMeetingPipelineChanged(meeting.id);
  log.info('recovery', 'iOS native post-processing reached durable import boundary', {
    meetingId: meeting.id,
    runId: result.identity.runId,
    disposition: result.disposition,
    acknowledged,
    completedWindows: result.coverage.completedWindows,
    failedWindows: result.coverage.failedWindows,
  });
  return acknowledged ? 'acknowledged' : 'retained';
}

/**
 * Foreground callers may intentionally ignore this promise; an OS/background
 * recovery caller awaits the same in-flight promise. That gives one execution
 * owner without blocking React rendering or reporting Worker success early.
 */
async function launchIOSPostProcessing(meeting: Meeting): Promise<boolean> {
  if (!meeting.audioUri) return false;
  const audioDirectory = meeting.audioUri;
  return iosPostProcessingOwner.run(meeting.id, async () => {
    let continuedHandle = activeIOSPostProcessingHandle(meeting.id);
    try {
      const session = await getMainaCloudSession();
      if (!session) throw new Error('authenticated_owner_unavailable');
      const audio = await prepareIOSNativePostProcessingAudio(meeting.id, audioDirectory);
      const request = buildIOSNativePostProcessingStartRequest({
        ownerUserId: session.user.userId,
        meetingId: meeting.id,
        audioFingerprintSha256: audio.audioFingerprintSha256,
      });
      const totalUnits = Math.max(1, Math.ceil(audio.audioDurationMs / request.windowConfig.targetWindowMs));
      if (!continuedHandle) {
        const continuedRequest = beginIOSContinuedProcessing(meeting.id, totalUnits);
        if (continuedRequest?.requestId) {
          continuedHandle = {
            requestId: continuedRequest.requestId,
            meetingId: meeting.id,
            asrGeneration: request.generation,
            deferralRequested: false,
            runtimeOwnerToken: request.runtimeOwnerToken,
          };
          iosPostProcessingHandles.set(continuedHandle.requestId, continuedHandle);
          iosPostProcessingHandleByMeeting.set(meeting.id, continuedHandle.requestId);
          if (!bindIOSContinuedProcessingRun(
            continuedHandle.requestId,
            meeting.id,
            request.generation,
          )) {
            removeIOSPostProcessingHandle(continuedHandle, false);
            continuedHandle = null;
            throw new Error('continued_processing_bind_failed');
          }
        }
      }
      const outcome = await startIOSNativePostProcessing(request, audioDirectory);
      const runningDisposition = await markIOSNativePostProcessingRunningIfUnimported({
        meetingId: meeting.id,
        completedUnits: 0,
        totalUnits,
        runId: request.runId,
        metadata: {
          runId: request.runId,
          generation: request.generation,
          executionOwner: 'ios-native-durable',
          resumed: outcome.resumed,
        },
      });
      if (runningDisposition === 'already_imported') {
        // The exact durable import fence is terminal authority. Stage repair is
        // deliberately isolated from the generic start-failure catch below:
        // a transient read/write failure must never downgrade an imported ASR
        // result back to transcribing/deferred. Startup reconciliation will
        // retry this idempotent repair without reopening native work.
        let repaired = false;
        try {
          const importedMeeting = await getMeeting(meeting.id);
          repaired = importedMeeting !== null
            && await repairIOSImportedPostProcessingStages(importedMeeting, request);
        } catch (cause) {
          log.warn('recovery', 'iOS imported post-processing stage repair retained for retry', {
            meetingId: meeting.id,
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        }
        if (continuedHandle) removeIOSPostProcessingHandle(continuedHandle, true);
        return repaired;
      }
      if (continuedHandle) updateIOSContinuedProcessing(continuedHandle.requestId, 0, totalUnits);
      await finishIOSNativePostProcessingResult(meeting, request);
      notifyMeetingPipelineChanged(meeting.id);
      log.info('recovery', 'iOS native post-processing accepted durable audio', {
        meetingId: meeting.id,
        runId: request.runId,
        resumed: outcome.resumed,
        state: outcome.state,
      });
      return true;
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
      if (continuedHandle) removeIOSPostProcessingHandle(continuedHandle, false);
      return false;
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

async function reconcilePendingNativeMeetingWorkInternal(
  explicitlyProtectedMeetingIds: readonly string[],
): Promise<number> {
  const nativeFence = readNativeCaptureAutomaticWorkFence();
  const protectedMeetingIds = new Set([
    ...explicitlyProtectedMeetingIds,
    ...nativeFence.protectedMeetingIds,
  ]);
  const nativeStatus = await getNativeCaptureStatusAsync().catch(() => null);
  // The native outbox heartbeat is durable, so it can still look active for
  // up to two minutes after Android kills the isolated ASR process. Trust that
  // heartbeat only while Maina's own post-processing service actually exists.
  // This makes foreground recovery immediate without starting duplicate ASR.
  const nativePostProcessingServiceRunning = isNativePostProcessingServiceRunning();
  const meetings = await listMeetings();
  let resumed = 0;

  for (const meeting of meetings) {
    if (protectedMeetingIds.has(meeting.id)) continue;
    if (Platform.OS === 'ios') {
      const session = await getMainaCloudSession().catch(() => null);
      if (!session) continue;
      let identity: IOSNativePostProcessingExecutionIdentity;
      try {
        identity = deriveIOSNativePostProcessingExecutionIdentity(session.user.userId, meeting.id);
      } catch {
        continue;
      }
      const terminal = await finishIOSNativePostProcessingResult(meeting, identity).catch((cause) => {
        log.warn('recovery', 'iOS native result remains retained for reconciliation', {
          meetingId: meeting.id,
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
        return 'retained' as const;
      });
      // The import transaction can commit before its exact readback, native
      // acknowledgement, or public-stage writes finish. Re-read the meeting
      // after every terminal-result attempt so a retained result cannot hide
      // an already-durable import fence and strand ASR as running/deferred.
      // Repair is idempotent and never reopens native work.
      const reconciledMeeting = await getMeeting(meeting.id).catch((cause) => {
        log.warn('recovery', 'iOS imported meeting read remains retained for reconciliation', {
          meetingId: meeting.id,
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
        return null;
      });
      if (reconciledMeeting?.nativePostprocessRunId === identity.runId
        && Number.isSafeInteger(reconciledMeeting.nativePostprocessImportedAt)
        && (reconciledMeeting.nativePostprocessImportedAt ?? 0) > 0) {
        try {
          await repairIOSImportedPostProcessingStages(reconciledMeeting, identity);
        } catch (cause) {
          // The durable import fence still owns the run. Retain stage repair
          // for a later wake without reopening native work or preventing
          // independent meetings in this reconciliation pass from advancing.
          log.warn('recovery', 'iOS imported post-processing stage repair retained for retry', {
            meetingId: meeting.id,
            causeName: cause instanceof Error ? cause.name : typeof cause,
          });
        }
        continue;
      }
      if (terminal === 'retained' || terminal === 'acknowledged') continue;

      const isLiveNativeMeeting = nativeStatus?.meetingId === meeting.id
        && nativeStatus.state !== 'idle'
        && nativeStatus.state !== 'error';
      if (isLiveNativeMeeting || !meeting.audioUri) continue;
      if (meeting.status === 'recording'
        || meeting.status === 'transcribing'
        || meeting.status === 'transcript_partial') {
        // Recovered iOS recordings must pass through the same durable capture
        // metrics/status transition as every other finalized native capture.
        // Calling launchIOSPostProcessing directly can leave the public row in
        // `recording` even after an exact native run has been accepted.
        if (await launchNativePostProcessing(meeting)) resumed += 1;
      }
      continue;
    }
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

export function reconcilePendingNativeMeetingWork(
  protectedMeetingIds: readonly string[] = [],
): Promise<number> {
  if (nativeReconciliationInFlight) return nativeReconciliationInFlight;
  let work: Promise<number>;
  work = reconcilePendingNativeMeetingWorkInternal(protectedMeetingIds).finally(() => {
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
