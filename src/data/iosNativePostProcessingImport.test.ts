/* eslint-disable import/first -- the SQLite double must precede the repository import. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlite = vi.hoisted(() => {
  const startedAt = 1_788_000_000_000;
  let meeting: Record<string, unknown>;
  let blocks: Record<string, unknown>[];
  let pipelineStage: Record<string, unknown> | null;
  const reset = () => {
    meeting = {
      id: 'meeting-a',
      started_at: startedAt,
      capture_ended_at: startedAt + 20_000,
      restart_count: 0,
      native_postprocess_run_id: null,
      native_postprocess_imported_at: null,
      status: 'transcribing',
      duration_ms: 20_000,
      audio_duration_ms: 20_000,
      segment_count: 1,
      transcribed_segments: 0,
      transcription_window_count: 0,
      transcription_completed_windows: 0,
      transcription_failed_windows: 0,
      transcription_recovery_rounds: 0,
      summary_status: 'idle',
    };
    blocks = [];
    pipelineStage = null;
  };
  reset();

  const transaction = {
    getFirstAsync: vi.fn(async (sql: string) => {
      if (sql.includes('native_postprocess_imported_at')) {
        return {
          native_postprocess_run_id: meeting.native_postprocess_run_id,
          native_postprocess_imported_at: meeting.native_postprocess_imported_at,
        };
      }
      if (sql.includes('meeting_pipeline_stages')) return pipelineStage && { ...pipelineStage };
      return {
        native_postprocess_run_id: meeting.native_postprocess_run_id,
        transcription_window_count: meeting.transcription_window_count,
        transcription_completed_windows: meeting.transcription_completed_windows,
        transcription_failed_windows: meeting.transcription_failed_windows,
        transcription_recovery_rounds: meeting.transcription_recovery_rounds,
        summary_status: meeting.summary_status,
      };
    }),
    runAsync: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('DELETE FROM transcript_blocks')) {
        blocks = [];
        return { changes: 1 };
      }
      if (sql.startsWith('DELETE FROM todo_items')) return { changes: 0 };
      if (sql.includes('INSERT INTO transcript_blocks')) {
        blocks.push({
          block_id: values[0], sequence: values[2], status: 'final',
          segment_index: values[3], started_at: values[4], ended_at: values[5],
          language: values[6], text: values[7], word_count: values[8], char_count: values[9],
        });
        return { changes: 1 };
      }
      if (sql.includes('UPDATE meetings') && sql.includes('native_postprocess_run_id')) {
        Object.assign(meeting, {
          duration_ms: values[1],
          audio_duration_ms: Math.max(Number(meeting.audio_duration_ms), Number(values[3])),
          segment_count: values[8],
          transcribed_segments: values[9],
          transcription_window_count: values[10],
          transcription_completed_windows: values[11],
          transcription_failed_windows: values[12],
          transcription_recovery_rounds: values[13],
          restart_count: values[14],
          status: values[15],
          native_postprocess_run_id: values[29],
          native_postprocess_imported_at: values[30],
        });
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO meeting_pipeline_stages')) {
        pipelineStage = {
          meeting_id: values[0], stage: 'asr', state: 'running', attempt_count: values[1],
          started_at: values[2], finished_at: values[3], updated_at: values[4], last_error: null,
          completed_units: values[5], total_units: values[6], metadata_json: values[7],
        };
        return { changes: 1 };
      }
      throw new Error(`Unexpected transaction SQL: ${sql}`);
    }),
  };

  const db = {
    getFirstAsync: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, started_at, capture_ended_at, restart_count')) {
        return {
          id: meeting.id,
          started_at: meeting.started_at,
          capture_ended_at: meeting.capture_ended_at,
          restart_count: meeting.restart_count,
          audio_duration_ms: meeting.audio_duration_ms,
        };
      }
      if (sql.includes('SELECT native_postprocess_run_id, status, started_at')) {
        return { ...meeting };
      }
      if (sql.includes('SELECT status, duration_ms, audio_duration_ms')) return { ...meeting };
      throw new Error(`Unexpected database SQL: ${sql}`);
    }),
    getAllAsync: vi.fn(async () => blocks.map((block) => ({ ...block }))),
    runAsync: vi.fn(async () => ({ changes: 0 })),
    withExclusiveTransactionAsync: vi.fn(async (work: (value: typeof transaction) => Promise<void>) => {
      await work(transaction);
    }),
  };
  return {
    db,
    transaction,
    reset,
    tamperFirstBlock: () => { if (blocks[0]) blocks[0].text = 'tampered'; },
    setImported: (runId: string, importedAt: number) => {
      meeting.native_postprocess_run_id = runId;
      meeting.native_postprocess_imported_at = importedAt;
    },
    setAudioDurationMs: (audioDurationMs: number) => {
      meeting.audio_duration_ms = audioDurationMs;
    },
    pipelineStage: () => pipelineStage && { ...pipelineStage },
  };
});

vi.mock('./db', () => ({
  getDb: vi.fn(async () => sqlite.db),
  withDurableWakeTransaction: vi.fn(),
  withImmediateWriteTransaction: vi.fn(async (work) => {
    let result: unknown;
    await sqlite.db.withExclusiveTransactionAsync(async (transaction) => {
      result = await work(transaction);
    });
    return result;
  }),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///documents/' }));

import {
  importIOSNativePostProcessingResult,
  markIOSNativePostProcessingRunningIfUnimported,
} from './meetings';
import { decodeIOSNativePostProcessingResult } from '@/services/nativePostProcessingCore';

const expectedIdentity = {
  ownerUserId: 'owner-a', meetingId: 'meeting-a', runId: 'run-a', generation: 1,
};

function result() {
  return decodeIOSNativePostProcessingResult({
    schemaVersion: 'maina.native-post-processing-result.v1',
    identity: {
      ...expectedIdentity, resultId: `npr_${'a'.repeat(32)}`,
      audioFingerprintSha256: 'b'.repeat(64), contractVersion: '1.0',
      modelId: 'qwen3-0.6b-int8', modelVersion: '1',
      runtimeVersion: 'sherpa-onnx-1.13.4-ios-no-tts', createdAt: '2026-09-09T00:00:00.000Z',
    },
    disposition: 'complete',
    audio: { durationMs: 20_000, segmentCount: 1 },
    windowConfig: { targetWindowMs: 10_000, analysisOverlapMs: 1_000, maxAttempts: 2 },
    windows: [
      {
        windowKey: 'window-0', index: 0, coverageStartMs: 0, coverageEndMs: 10_000,
        analysisStartMs: 0, analysisEndMs: 11_000, status: 'completed',
        blocks: [{
          blockKey: 'block-0', sequence: 0, startedAtMs: 0, endedAtMs: 10_000,
          text: 'first block', language: 'en',
        }],
        retry: { attemptCount: 1, maxAttempts: 2, lastReasonCode: 'NONE' },
        vad: { status: 'speech', evidenceSha256: 'c'.repeat(64) },
      },
      {
        windowKey: 'window-1', index: 1, coverageStartMs: 10_000, coverageEndMs: 20_000,
        analysisStartMs: 9_000, analysisEndMs: 20_000, status: 'completed',
        blocks: [{
          blockKey: 'block-1', sequence: 1, startedAtMs: 10_000, endedAtMs: 20_000,
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
  }, expectedIdentity);
}

describe('iOS native post-processing import acknowledgement fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite.reset();
    vi.spyOn(Date, 'now').mockReturnValue(1_788_000_030_000);
  });

  it('returns stable evidence only after exact committed rows can be reread', async () => {
    const first = await importIOSNativePostProcessingResult(result());
    expect(first).toEqual({
      importedAt: '2026-08-29T10:40:30.000Z',
      transactionCommitSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(importIOSNativePostProcessingResult(result())).resolves.toEqual(first);
    expect(sqlite.db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
  });

  it('withholds acknowledgement evidence when post-commit transcript truth drifts', async () => {
    await expect(importIOSNativePostProcessingResult(result())).resolves.not.toBeNull();
    sqlite.tamperFirstBlock();
    await expect(importIOSNativePostProcessingResult(result())).resolves.toBeNull();
  });

  it('binds monotonic capture duration when it exceeds the analyzed window duration', async () => {
    sqlite.setAudioDurationMs(20_250);

    const evidence = await importIOSNativePostProcessingResult(result());

    expect(evidence).toEqual({
      importedAt: '2026-08-29T10:40:30.000Z',
      transactionCommitSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(sqlite.db.withExclusiveTransactionAsync).toHaveBeenCalledTimes(1);
  });
});

describe('iOS native post-processing running publication fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite.reset();
  });

  it('writes running only while no terminal import owns the meeting', async () => {
    await expect(markIOSNativePostProcessingRunningIfUnimported({
      meetingId: 'meeting-a', runId: 'run-a', completedUnits: 0, totalUnits: 2,
      metadata: { executionOwner: 'ios-native-durable' }, now: 100,
    })).resolves.toBe('running');
    expect(sqlite.pipelineStage()).toMatchObject({
      state: 'running', attempt_count: 1, completed_units: 0, total_units: 2,
    });

    const writesBeforeImport = sqlite.transaction.runAsync.mock.calls.length;
    sqlite.setImported('run-a', 200);
    await expect(markIOSNativePostProcessingRunningIfUnimported({
      meetingId: 'meeting-a', runId: 'run-a', completedUnits: 0, totalUnits: 2,
      metadata: { executionOwner: 'ios-native-durable' }, now: 300,
    })).resolves.toBe('already_imported');
    expect(sqlite.transaction.runAsync).toHaveBeenCalledTimes(writesBeforeImport);
  });

  it('rejects a different imported run instead of overwriting terminal truth', async () => {
    sqlite.setImported('run-other', 200);
    await expect(markIOSNativePostProcessingRunningIfUnimported({
      meetingId: 'meeting-a', runId: 'run-a', completedUnits: 0, totalUnits: 2,
      metadata: { executionOwner: 'ios-native-durable' }, now: 300,
    })).rejects.toThrow('identity conflicts');
    expect(sqlite.pipelineStage()).toBeNull();
  });
});
