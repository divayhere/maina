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
  readResult: vi.fn(async () => null as unknown),
  start: vi.fn(async () => ({ state: 'running', resumed: false })),
  updateMeeting: vi.fn(async () => {}),
  updateStage: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/data/meetings', () => ({
  getMeeting: vi.fn(async () => null),
  getTranscriptSummary: vi.fn(async () => null),
  importIOSNativePostProcessingResult: mocks.importResult,
  importNativePostProcessingResult: vi.fn(async () => 'imported'),
  listMeetings: vi.fn(async () => [{ ...mocks.meeting }]),
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
vi.mock('@/services/meetingPipelineSignals', () => ({ notifyMeetingPipelineChanged: vi.fn() }));
vi.mock('@/services/nativeCaptureMetrics', () => ({ getNativeCaptureMetrics: vi.fn() }));
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

    expect(mocks.readResult).toHaveBeenCalledWith(identity);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.prepareAudio).not.toHaveBeenCalled();
  });

  it('starts one stable owner-bound native run when no terminal result or import exists', async () => {
    await expect(reconcilePendingNativeMeetingWork()).resolves.toBe(1);

    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining(identity), mocks.meeting.audioUri);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
});
