import { describe, expect, it } from 'vitest';

import {
  buildIOSNativePostProcessingImportFence,
  buildIOSNativePostProcessingStartRequest,
  decodeIOSNativePostProcessingResult,
  deriveIOSNativeImportCommitSha256,
  deriveIOSNativePostProcessingExecutionIdentity,
  deriveNativeTranscriptOutcome,
  nativeProgress,
  sha256Utf8,
  shouldImportNativePostProcessingResult,
  shouldRepairNativeTranscriptStatus,
} from './nativePostProcessingCore';

const nativeResultIdentity = {
  ownerUserId: 'owner-a',
  meetingId: 'meeting-a',
  runId: 'run-a',
  generation: 1,
};

function completeNativeResult(): Record<string, unknown> {
  return {
    schemaVersion: 'maina.native-post-processing-result.v1',
    identity: {
      ...nativeResultIdentity,
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
    windowConfig: { targetWindowMs: 10_000, analysisOverlapMs: 1_000, maxAttempts: 2 },
    windows: [
      {
        windowKey: 'window-0', index: 0,
        coverageStartMs: 0, coverageEndMs: 10_000,
        analysisStartMs: 0, analysisEndMs: 11_000,
        status: 'completed',
        blocks: [{
          blockKey: 'block-0', sequence: 0, startedAtMs: 0, endedAtMs: 10_000,
          text: 'first block', language: 'en',
        }],
        retry: { attemptCount: 1, maxAttempts: 2, lastReasonCode: 'NONE' },
        vad: { status: 'unavailable', evidenceSha256: 'c'.repeat(64) },
      },
      {
        windowKey: 'window-1', index: 1,
        coverageStartMs: 10_000, coverageEndMs: 20_000,
        analysisStartMs: 9_000, analysisEndMs: 20_000,
        status: 'completed',
        blocks: [{
          blockKey: 'block-1', sequence: 1, startedAtMs: 10_000, endedAtMs: 20_000,
          text: 'second block', language: 'en',
        }],
        retry: { attemptCount: 1, maxAttempts: 2, lastReasonCode: 'NONE' },
        vad: { status: 'unavailable', evidenceSha256: 'd'.repeat(64) },
      },
    ],
    unresolvedIntervals: [],
    coverage: {
      windowCount: 2, completedWindows: 2, failedWindows: 0,
      unresolvedWindows: 0, coverageComplete: true,
    },
    resultPayloadSha256: 'e'.repeat(64),
  };
}

describe('native transcript truth model', () => {
  it('derives standard SHA-256 vectors and stable owner-bound execution identities', () => {
    expect(sha256Utf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Utf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const identity = deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a');
    expect(identity).toEqual(deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a'));
    expect(identity.runId).toMatch(/^iosnpr_[a-f0-9]{32}$/);
    expect(identity.runtimeOwnerToken).toMatch(/^iosruntime_[a-f0-9]{32}$/);
    expect(deriveIOSNativePostProcessingExecutionIdentity('owner-b', 'meeting-a').runId)
      .not.toBe(identity.runId);
    expect(() => deriveIOSNativePostProcessingExecutionIdentity('owner/a', 'meeting-a')).toThrow('identity is invalid');
  });

  it('seals exact post-commit import evidence deterministically', () => {
    const evidence = {
      ownerUserId: 'owner-a', meetingId: 'meeting-a', runId: 'run-a', generation: 1,
      resultId: `npr_${'a'.repeat(32)}`, resultPayloadSha256: 'b'.repeat(64),
      importedAtMs: 1_788_000_000_000, durationMs: 20_000, audioDurationMs: 20_100, segmentCount: 1,
      windowCount: 2, completedWindows: 2, failedWindows: 0, blockCount: 2,
    };
    const digest = deriveIOSNativeImportCommitSha256(evidence);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveIOSNativeImportCommitSha256(evidence)).toBe(digest);
    expect(deriveIOSNativeImportCommitSha256({ ...evidence, blockCount: 1 })).not.toBe(digest);
    expect(deriveIOSNativeImportCommitSha256({ ...evidence, audioDurationMs: 20_101 })).not.toBe(digest);
  });

  it('builds one exact native start and a closed post-commit acknowledgement fence', () => {
    const start = buildIOSNativePostProcessingStartRequest({
      ownerUserId: 'owner-a',
      meetingId: 'meeting-a',
      audioFingerprintSha256: 'b'.repeat(64),
    });
    expect(start).toEqual({
      ...deriveIOSNativePostProcessingExecutionIdentity('owner-a', 'meeting-a'),
      audioFingerprintSha256: 'b'.repeat(64),
      windowConfig: { targetWindowMs: 15_000, analysisOverlapMs: 2_000, maxAttempts: 2 },
    });
    expect(() => buildIOSNativePostProcessingStartRequest({
      ownerUserId: 'owner-a', meetingId: 'meeting-a', audioFingerprintSha256: 'not-a-digest',
    })).toThrow('fingerprint is invalid');

    const decoded = decodeIOSNativePostProcessingResult(completeNativeResult(), nativeResultIdentity);
    const fence = buildIOSNativePostProcessingImportFence(decoded, {
      importedAt: '2026-09-09T01:02:03.004Z',
      transactionCommitSha256: 'f'.repeat(64),
    });
    expect(fence).toEqual({
      schemaVersion: 'maina.native-post-processing-import-fence.v1',
      state: 'DURABLE',
      ownerUserId: 'owner-a',
      meetingId: 'meeting-a',
      runId: 'run-a',
      generation: 1,
      resultId: `npr_${'a'.repeat(32)}`,
      resultPayloadSha256: 'e'.repeat(64),
      importedAt: '2026-09-09T01:02:03.004Z',
      transactionCommitSha256: 'f'.repeat(64),
    });
    expect(() => buildIOSNativePostProcessingImportFence(decoded, {
      importedAt: 'not-a-time', transactionCommitSha256: 'f'.repeat(64),
    })).toThrow('import fence is invalid');
  });

  it('accepts only an exact owner-bound complete native result partition', () => {
    const decoded = decodeIOSNativePostProcessingResult(completeNativeResult(), nativeResultIdentity);
    expect(decoded.disposition).toBe('complete');
    expect(decoded.coverage).toEqual({
      windowCount: 2, completedWindows: 2, failedWindows: 0,
      unresolvedWindows: 0, coverageComplete: true,
    });
  });

  it('rejects unknown fields and a cross-owner native result before import', () => {
    expect(() => decodeIOSNativePostProcessingResult({
      ...completeNativeResult(), rawPath: '/private/container',
    }, nativeResultIdentity)).toThrow('contract mismatch');
    expect(() => decodeIOSNativePostProcessingResult(completeNativeResult(), {
      ...nativeResultIdentity, ownerUserId: 'owner-b',
    })).toThrow('contract mismatch');
  });

  it('rejects coverage gaps and internally inconsistent completeness', () => {
    const gap = completeNativeResult();
    (gap.windows as Record<string, unknown>[])[1] = {
      ...(gap.windows as Record<string, unknown>[])[1], coverageStartMs: 10_001,
    };
    expect(() => decodeIOSNativePostProcessingResult(gap, nativeResultIdentity))
      .toThrow('contract mismatch');

    const falseComplete = completeNativeResult();
    falseComplete.coverage = {
      windowCount: 2, completedWindows: 2, failedWindows: 0,
      unresolvedWindows: 0, coverageComplete: false,
    };
    expect(() => decodeIOSNativePostProcessingResult(falseComplete, nativeResultIdentity))
      .toThrow('contract mismatch');
  });

  it('accepts a partial result only when its failed interval is exact', () => {
    const partial = completeNativeResult();
    partial.disposition = 'partial';
    const windows = partial.windows as Record<string, unknown>[];
    windows[1] = {
      ...windows[1], status: 'failed', blocks: [],
      retry: { attemptCount: 2, maxAttempts: 2, lastReasonCode: 'AUDIO_UNREADABLE' },
    };
    partial.unresolvedIntervals = [{
      windowKey: 'window-1', startMs: 10_000, endMs: 20_000,
      outcome: 'failed', reasonCode: 'AUDIO_UNREADABLE',
    }];
    partial.coverage = {
      windowCount: 2, completedWindows: 1, failedWindows: 1,
      unresolvedWindows: 0, coverageComplete: false,
    };
    expect(decodeIOSNativePostProcessingResult(partial, nativeResultIdentity).disposition)
      .toBe('partial');

    (partial.unresolvedIntervals as Record<string, unknown>[])[0].startMs = 9_999;
    expect(() => decodeIOSNativePostProcessingResult(partial, nativeResultIdentity))
      .toThrow('contract mismatch');
  });

  it('does not promote a 190 of 216 transcript to complete or cloud-eligible', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: true,
      windowCount: 216,
      completedWindows: 190,
      failedWindows: 26,
      lastError: 'Speech-like audio returned no text.',
    })).toEqual({
      status: 'transcript_partial',
      coverageComplete: false,
      error: 'Speech-like audio returned no text.',
    });
  });

  it('promotes only complete non-empty coverage', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: true,
      windowCount: 216,
      completedWindows: 216,
      failedWindows: 0,
    })).toEqual({ status: 'transcribed', coverageComplete: true, error: null });
  });

  it('keeps audio recovery when complete windows contain no text', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: false,
      windowCount: 2,
      completedWindows: 2,
      failedWindows: 0,
    }).status).toBe('recorded');
  });

  it('reports persisted window progress without invented fallback values', () => {
    expect(nativeProgress({ windowCount: 216, completedWindows: 47, failedWindows: 1 }))
      .toEqual({ completed: 48, total: 216, ratio: 48 / 216 });
    expect(nativeProgress({ windowCount: 0, completedWindows: 0, failedWindows: 0 }).ratio)
      .toBeNull();
  });

  it('imports a durable retry when the same run advances from partial to complete', () => {
    expect(shouldImportNativePostProcessingResult({
      persistedRunId: 'run-1',
      persistedWindowCount: 13,
      persistedCompletedWindows: 12,
      persistedFailedWindows: 1,
      incomingRunId: 'run-1',
      incomingWindowCount: 13,
      incomingCompletedWindows: 13,
      incomingFailedWindows: 0,
    })).toBe(true);
  });

  it('does not continuously re-import an unchanged durable run', () => {
    expect(shouldImportNativePostProcessingResult({
      persistedRunId: 'run-1',
      persistedWindowCount: 13,
      persistedCompletedWindows: 13,
      persistedFailedWindows: 0,
      incomingRunId: 'run-1',
      incomingWindowCount: 13,
      incomingCompletedWindows: 13,
      incomingFailedWindows: 0,
    })).toBe(false);
  });

  it('repairs a stale in-progress row from an already imported terminal result', () => {
    expect(shouldRepairNativeTranscriptStatus({
      persistedStatus: 'transcribing',
      incomingStatus: 'transcribed',
    })).toBe(true);
  });

  it('never moves a meeting backward after summary work has begun', () => {
    expect(shouldRepairNativeTranscriptStatus({
      persistedStatus: 'summarizing',
      incomingStatus: 'transcribed',
    })).toBe(false);
    expect(shouldRepairNativeTranscriptStatus({
      persistedStatus: 'summarized',
      incomingStatus: 'transcribed',
    })).toBe(false);
  });
});
