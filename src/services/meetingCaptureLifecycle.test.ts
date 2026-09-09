/* eslint-disable import/first -- Vitest doubles must exist before the lifecycle module is imported. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  meeting: {
    id: 'meeting-a',
    status: 'transcribing',
    audioUri: 'file:///documents/recordings/meeting-a',
    startedAt: 1_788_000_000_000,
    captureEndedAt: 1_788_000_020_000,
    durationMs: 20_000,
    audioDurationMs: 20_000,
    segmentCount: 1,
    restartCount: 0,
    captureGapMs: 0,
    nativePostprocessRunId: null as string | null,
    nativePostprocessImportedAt: null as number | null,
    transcriptionWindowCount: 0,
    transcriptionCompletedWindows: 0,
    transcriptionFailedWindows: 0,
    transcriptionRecoveryRounds: 0,
  },
  nativeResult: null as unknown,
  durableImport: null as { importedAt: string; transactionCommitSha256: string } | null,
  acknowledge: vi.fn(async () => true),
  cleanup: vi.fn(async () => {}),
  importResult: vi.fn(async () => null as { importedAt: string; transactionCommitSha256: string } | null),
  prepareAudio: vi.fn(async () => ({
    audioFingerprintSha256: 'b'.repeat(64),
    audioDurationMs: 20_000,
    segmentCount: 1,
  })),
  captureMetrics: {
    finalizedUris: ['file:///documents/recordings/meeting-a/capture-00000.wav'],
    partialUris: [],
    recoveredCount: 0,
    invalidPartialCount: 0,
    journalUri: 'file:///documents/recordings/meeting-a/capture-journal.jsonl',
    audioDurationMs: 20_000,
    wallDurationMs: 20_000,
    startedAt: 1_788_000_000_000,
    stoppedAt: 1_788_000_020_000,
    routeRestartCount: 0,
    captureGapMs: 0,
    hasStopEvent: true,
  },
  readResult: vi.fn(async (_request?: Record<string, unknown>) => null as unknown),
  start: vi.fn(async () => ({ state: 'running', resumed: false })),
  markRunning: vi.fn(async (): Promise<'running' | 'already_imported'> => 'running'),
  getStages: vi.fn(async () => [] as { stage: string; state: string }[]),
  getTranscriptSummary: vi.fn(async () => null as { hasText: boolean } | null),
  notify: vi.fn(),
  updateMeeting: vi.fn(async () => {}),
  updateStage: vi.fn(async (_stage: Record<string, unknown>) => {}),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/data/meetings', () => ({
  getMeeting: vi.fn(async () => ({ ...mocks.meeting })),
  getMeetingPipelineStages: mocks.getStages,
  getTranscriptSummary: mocks.getTranscriptSummary,
  importIOSNativePostProcessingResult: mocks.importResult,
  importNativePostProcessingResult: vi.fn(async () => 'imported'),
  listMeetings: vi.fn(async () => [{ ...mocks.meeting }]),
  markIOSNativePostProcessingRunningIfUnimported: mocks.markRunning,
  updateMeeting: mocks.updateMeeting,
  updateMeetingPipelineStage: mocks.updateStage,
  updateNativePostProcessingProgress: vi.fn(async () => {}),
}));
vi.mock('@/core/recording/checkpoint', () => ({ completedCaptureDurationRepair: vi.fn(() => null) }));
vi.mock('@/core/recording/captureGap', () => ({ materialCaptureGapError: vi.fn(() => null) }));
vi.mock('@/core/pipeline/keyedExecutionOwner', () => ({
  createKeyedExecutionOwner: () => ({ run: (_key: string, task: () => Promise<boolean>) => task() }),
}));
vi.mock('@/core/transcription/asr/iosContinuedProcessingPolicy', () => ({
  createIOSContinuedProcessingDeferralHandler: () => vi.fn(async () => 'fenced'),
}));
vi.mock('@/core/recording/nativeCaptureReconciliation', () => ({
  hasCompleteNativeTranscript: vi.fn(() => false),
  terminalNativeMeetingRepair: vi.fn(() => null),
}));
vi.mock('@/hardware/recording/foreground', () => ({
  acknowledgeNativePostProcessingResult: vi.fn(async () => true),
  acknowledgeIOSNativePostProcessingResult: mocks.acknowledge,
  acknowledgeIOSContinuedProcessingDeferral: vi.fn(),
  beginIOSContinuedProcessing: vi.fn(() => null),
  bindIOSContinuedProcessingRun: vi.fn(() => true),
  finishIOSContinuedProcessing: vi.fn(),
  getNativeCaptureStatusAsync: vi.fn(async () => ({ state: 'idle', meetingId: null })),
  isNativePostProcessingServiceRunning: vi.fn(() => false),
  prepareIOSNativePostProcessingAudio: mocks.prepareAudio,
  readIOSNativePostProcessingResult: mocks.readResult,
  readNativePostProcessingResult: vi.fn(async () => null),
  releaseIOSNativePostProcessingAsr: vi.fn(async () => true),
  startIOSNativePostProcessing: mocks.start,
  startNativePostProcessing: vi.fn(async () => {}),
  subscribeIOSPostProcessingDeferralRequests: vi.fn(),
  updateIOSContinuedProcessing: vi.fn(),
}));
vi.mock('@/services/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/services/audioRetention', () => ({ cleanupTerminalMeetingAudio: mocks.cleanup }));
vi.mock('@/services/meetingPipelineSignals', () => ({ notifyMeetingPipelineChanged: mocks.notify }));
vi.mock('@/services/nativeCaptureMetrics', () => ({
  getNativeCaptureMetrics: vi.fn(async () => ({ ...mocks.captureMetrics })),
}));
vi.mock('@/services/meetingPacket', () => ({
  drainMeetingPacketUntilSettled: vi.fn(async () => {}),
  maybeQueueMeetingPacket: vi.fn(async () => {}),
}));
vi.mock('@/services/mainaKnowledgeCloud', () => ({
  reconcilePendingMainaKnowledgeCloudSyncs: vi.fn(async () => 0),
}));
vi.mock('@/services/mainaCloudSession', () => ({
  getMainaCloudSession: vi.fn(async () => ({ user: { userId: 'owner-a' } })),
}));
vi.mock('@/services/transcriptCoverage', () => ({ TERMINAL_PARTIAL_RECOVERY_ROUNDS: 2 }));

import { reconcilePendingNativeMeetingWork } from './meetingCaptureLifecycle';
import {
  decodeIOSNativePostProcessingResult,
  deriveIOSNativePostProcessingExecutionIdentity,
} from './nativePostProcessingCore';

function completeResult() {
  const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
  return decodeIOSNativePostProcessingResult({
    schemaVersion: 'maina.native-post-processing-result.v1',
    identity: {
      ownerUserId: identity.ownerUserId,
      meetingId: identity.meetingId,
      runId: identity.runId,
      generation: identity.generation,
      resultId: `npr_${'a'.repeat(32)}`,
      audioFingerprintSha256: 'b'.repeat(64),
      contractVersion: '1.0',
      modelId: 'qwen3-0.6b-int8',
      modelVersion: '1',
      runtimeVersion: 'sherpa-onnx-1.13.4-ios-no-tts',
      createdAt: '2026-09-09T00:00:00.000Z',
    },
    disposition: 'complete',
    audio: { durationMs: 20_000, segmentCount: 1 },
    windowConfig: { targetWindowMs: 15_000, analysisOverlapMs: 2_000, maxAttempts: 2 },
    windows: [
      {
        windowKey: 'window-0', index: 0,
        coverageStartMs: 0, coverageEndMs: 15_000,
        analysisStartMs: 0, analysisEndMs: 17_000,
        status: 'completed',
        blocks: [{
          blockKey: 'block-0', sequence: 0, startedAtMs: 0, endedAtMs: 15_000,
          text: 'first block', language: 'en',
        }],
        retry: { attemptCount: 1, maxAttempts: 2, lastReasonCode: 'NONE' },
        vad: { status: 'speech', evidenceSha256: 'c'.repeat(64) },
      },
      {
        windowKey: 'window-1', index: 1,
        coverageStartMs: 15_000, coverageEndMs: 20_000,
        analysisStartMs: 13_000, analysisEndMs: 20_000,
        status: 'completed',
        blocks: [{
          blockKey: 'block-1', sequence: 1, startedAtMs: 15_000, endedAtMs: 20_000,
          text: 'second block', language: 'en',
        }],
        retry: { attemptCount: 1, maxAttempts: 2, lastReasonCode: 'NONE' },
        vad: { status: 'speech', evidenceSha256: 'd'.repeat(64) },
      },
    ],
    unresolvedIntervals: [],
    coverage: {
      windowCount: 2, completedWindows: 2, failedWindows: 0,
      unresolvedWindows: 0, coverageComplete: true,
    },
    resultPayloadSha256: 'e'.repeat(64),
  }, identity);
}

describe('iOS durable native post-processing lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.meeting, {
      status: 'transcribing',
      nativePostprocessRunId: null,
      nativePostprocessImportedAt: null,
    });
    mocks.nativeResult = null;
    mocks.durableImport = {
      importedAt: '2026-09-09T00:01:00.000Z',
      transactionCommitSha256: 'f'.repeat(64),
    };
    mocks.readResult.mockImplementation(async () => mocks.nativeResult);
    mocks.importResult.mockImplementation(async () => mocks.durableImport);
    mocks.acknowledge.mockResolvedValue(true);
    mocks.markRunning.mockResolvedValue('running');
    mocks.getStages.mockResolvedValue([]);
    mocks.getTranscriptSummary.mockResolvedValue(null);
    mocks.updateStage.mockImplementation(async () => {});
  });

  it('acknowledges and cleans complete audio only after exact durable import evidence', async () => {
    mocks.nativeResult = completeResult();

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.importResult).toHaveBeenCalledWith(mocks.nativeResult);
    expect(mocks.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      state: 'DURABLE',
      ownerUserId: 'owner-a',
      meetingId: 'meeting-a',
      runId: (mocks.nativeResult as ReturnType<typeof completeResult>).identity.runId,
      transactionCommitSha256: 'f'.repeat(64),
    }));
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('retains the native result and audio when post-commit evidence is unavailable', async () => {
    mocks.nativeResult = completeResult();
    mocks.durableImport = null;

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('repairs public stages when retained readback follows a committed native import', async () => {
    const result = completeResult();
    mocks.nativeResult = result;
    mocks.getTranscriptSummary.mockResolvedValue({ hasText: true });
    mocks.importResult.mockImplementationOnce(async () => {
      mocks.meeting.nativePostprocessRunId = result.identity.runId;
      mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
      mocks.meeting.transcriptionWindowCount = result.coverage.windowCount;
      mocks.meeting.transcriptionCompletedWindows = result.coverage.completedWindows;
      mocks.meeting.transcriptionFailedWindows = result.coverage.failedWindows;
      return null;
    });

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'asr', state: 'ready',
    }));
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'transcript_durable', state: 'ready',
    }));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('replays the same committed result after acknowledgement failure without starting a duplicate run', async () => {
    mocks.nativeResult = completeResult();
    mocks.acknowledge.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.importResult).toHaveBeenCalledTimes(2);
    expect(mocks.acknowledge).toHaveBeenCalledTimes(2);
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('does not reopen ASR after the exact run was imported and native acknowledgement removed it', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.meeting.nativePostprocessRunId = identity.runId;
    mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.readResult).toHaveBeenCalledWith({
      ownerUserId: identity.ownerUserId,
      meetingId: identity.meetingId,
      runId: identity.runId,
      generation: identity.generation,
    });
    const readRequest = mocks.readResult.mock.calls[0][0];
    expect(readRequest).toBeDefined();
    expect(Object.keys(readRequest!).sort()).toEqual([
      'generation', 'meetingId', 'ownerUserId', 'runId',
    ]);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.prepareAudio).not.toHaveBeenCalled();
  });

  it('starts one stable owner-bound native run when no terminal result or import exists', async () => {
    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(1);

    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining(identity), mocks.meeting.audioUri);
    expect(mocks.updateMeeting).toHaveBeenCalledWith('meeting-a', expect.objectContaining({
      status: 'transcribing',
      audioDurationMs: 20_000,
      segmentCount: 1,
    }));
    expect(mocks.updateMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0],
    );
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('reopens the exact idempotent run after a native-result read failure instead of stranding recording', async () => {
    mocks.meeting.status = 'recording';
    mocks.readResult.mockRejectedValueOnce(new Error('bounded native read failure'));

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(1);

    // The first read fails; the exact owner/run start is then accepted and its
    // immediate post-start terminal read observes no completed result yet.
    expect(mocks.readResult).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.updateMeeting).toHaveBeenCalledWith('meeting-a', expect.objectContaining({
      status: 'transcribing',
      captureDisposition: 'partial_capture_failure',
      audioDurationMs: 20_000,
      segmentCount: 1,
    }));
    expect(mocks.updateMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0],
    );
  });

  it('never republishes running after a concurrent terminal import wins the start race', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.markRunning.mockImplementationOnce(async () => {
      mocks.meeting.nativePostprocessRunId = identity.runId;
      mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
      return 'already_imported';
    });

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(1);

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.markRunning).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a',
      runId: identity.runId,
    }));
    expect(mocks.updateStage).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'running' }));
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'asr', state: 'ready',
    }));
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'transcript_durable', state: 'failed',
    }));
  });

  it('never downgrades an imported run when terminal-stage repair cannot read its stages', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.markRunning.mockImplementationOnce(async () => {
      mocks.meeting.nativePostprocessRunId = identity.runId;
      mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
      return 'already_imported';
    });
    mocks.getStages.mockRejectedValueOnce(new Error('bounded stage read failure'));

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.updateMeeting).not.toHaveBeenCalledWith('meeting-a', expect.objectContaining({
      lastError: 'Local transcription paused safely. Maina will continue automatically.',
    }));
    expect(mocks.updateStage).not.toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'asr', state: 'deferred',
    }));
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('keeps a partially repaired imported ASR terminal when transcript-stage repair fails', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.markRunning.mockImplementationOnce(async () => {
      mocks.meeting.nativePostprocessRunId = identity.runId;
      mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
      return 'already_imported';
    });
    mocks.updateStage.mockImplementation(async (stage) => {
      if (stage.stage === 'transcript_durable') {
        throw new Error('bounded transcript stage write failure');
      }
    });

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'asr', state: 'ready',
    }));
    expect(mocks.updateMeeting).not.toHaveBeenCalledWith('meeting-a', expect.objectContaining({
      lastError: 'Local transcription paused safely. Maina will continue automatically.',
    }));
    expect(mocks.updateStage).not.toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'meeting-a', stage: 'asr', state: 'deferred',
    }));
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('does not reopen a run when terminal import fails before a durable import fence exists', async () => {
    mocks.nativeResult = completeResult();
    mocks.importResult.mockRejectedValueOnce(new Error('durable import unavailable'));

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.updateMeeting).not.toHaveBeenCalled();
  });

  it('keeps an imported exact run fenced when a later native read is unavailable', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.meeting.nativePostprocessRunId = identity.runId;
    mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
    mocks.readResult.mockRejectedValueOnce(new Error('bounded native read failure'));

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.prepareAudio).not.toHaveBeenCalled();
  });

  it('does not open another pipeline signal when imported terminal stages are already truthful', async () => {
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    mocks.meeting.nativePostprocessRunId = identity.runId;
    mocks.meeting.nativePostprocessImportedAt = 1_788_000_030_000;
    mocks.getStages.mockResolvedValue([
      { stage: 'asr', state: 'ready' },
      { stage: 'transcript_durable', state: 'failed' },
    ]);

    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(0);

    expect(mocks.updateStage).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
