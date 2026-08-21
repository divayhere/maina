import { planAsrWindows, removeExactTextOverlap } from '@/core/transcription/asr/windowing';
import { transcriptWordCount } from '@/core/transcription/transcript';
import {
  commitTranscriptFinalBlocks,
  finishRecordingSegment,
  getTranscriptSummary,
  resetMeetingTranscript,
  startRecordingSegment,
  type TranscriptBlock,
  updateMeeting,
} from '@/data/meetings';
import {
  getPcmWavDurationsMs,
  getQwenAsrStatus,
  inspectNativeCaptureDirectory,
  releaseQwenAsr,
  transcribeWithQwen,
} from '@/hardware/recording/foreground';
import { log } from '@/services/logger';
import { queueAudioArtifact } from '@/services/remoteLog';

export interface LocalAsrPipelineResult {
  hasText: boolean;
  wordCount: number;
  blockCount: number;
  chunkCount: number;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  coverageComplete: boolean;
  recoveredChunks: number;
  lastError: string | null;
}

export async function runLocalAsrPipeline(input: {
  meetingId: string;
  directory: string;
  meetingStartedAt: number;
  recoverPartials: boolean;
  resetTranscript?: boolean;
  onBlocks?: (blocks: TranscriptBlock[]) => void;
}): Promise<LocalAsrPipelineResult> {
  const inspection = await inspectNativeCaptureDirectory(input.directory, input.recoverPartials);
  const chunks = inspection.finalizedUris;
  log.info('asr', 'native capture directory inspected', {
    meetingId: input.meetingId,
    finalizedChunks: chunks.length,
    partialChunks: inspection.partialUris.length,
    recoveredCount: inspection.recoveredCount,
    invalidPartialCount: inspection.invalidPartialCount,
    recoverPartials: input.recoverPartials,
  });

  if (input.resetTranscript) await resetMeetingTranscript(input.meetingId);
  await updateMeeting(input.meetingId, {
    status: chunks.length > 0 ? 'transcribing' : 'recorded',
    segmentCount: chunks.length,
    transcribedSegments: 0,
  });
  if (chunks.length === 0) {
    const lastError = inspection.partialUris.length > 0
      ? 'Audio finalization is still incomplete; recovery audio was preserved.'
      : 'Native capture produced no finalized WAV chunks.';
    await updateMeeting(input.meetingId, { status: 'recorded', lastError });
    log.warn('asr', 'native capture produced no finalized WAV chunks', {
      meetingId: input.meetingId,
      directory: input.directory,
      partialChunks: inspection.partialUris.length,
    });
    return {
      hasText: false,
      wordCount: 0,
      blockCount: 0,
      chunkCount: 0,
      windowCount: 0,
      completedWindows: 0,
      failedWindows: 1,
      coverageComplete: false,
      recoveredChunks: inspection.recoveredCount,
      lastError,
    };
  }

  const modelStatus = await getQwenAsrStatus();
  log.info('asr', 'qwen status before post-call transcription', modelStatus
    ? { ready: modelStatus.ready, root: modelStatus.root, reason: modelStatus.reason ?? null }
    : { ready: false });
  if (!modelStatus?.ready) {
    const lastError = modelStatus?.reason ?? 'Qwen model pack is not installed';
    await updateMeeting(input.meetingId, { status: 'recorded', lastError });
    return {
      hasText: false,
      wordCount: 0,
      blockCount: 0,
      chunkCount: chunks.length,
      windowCount: 0,
      completedWindows: 0,
      failedWindows: chunks.length,
      coverageComplete: false,
      recoveredChunks: inspection.recoveredCount,
      lastError,
    };
  }

  const durations = await getPcmWavDurationsMs(chunks).catch(() => ({} as Record<string, number | null>));
  let chunkCursorAt = input.meetingStartedAt;
  let windowCount = 0;
  let completedWindows = 0;
  let failedWindows = 0;
  let previousText = '';
  let lastError: string | null = null;

  try {
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const uri = chunks[chunkIndex];
      const durationMs = durations[uri] ?? 0;
      await startRecordingSegment(input.meetingId, chunkIndex, uri).catch(() => {});
      await finishRecordingSegment(input.meetingId, chunkIndex, uri).catch(() => {});
      await queueAudioArtifact({
        artifactId: `${input.meetingId}-native-audio-${chunkIndex}`,
        meetingId: input.meetingId,
        segmentIndex: chunkIndex,
        sourceUri: uri,
        durationMs,
      }).catch((cause) => log.warn('remote', 'native audio artifact queue failed', {
        err: String(cause),
        chunkIndex,
      }));

      const windows = planAsrWindows(durationMs);
      windowCount += windows.length;
      for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
        const window = windows[windowIndex];
        const ordinal = completedWindows + failedWindows + 1;
        try {
          const result = await transcribeWithQwen(uri, window.startMs, window.endMs);
          const rawText = result.text.trim();
          const text = removeExactTextOverlap(previousText, rawText);
          const suspiciousEmpty = result.speechExpected && !rawText;
          const suspicious = suspiciousEmpty || result.truncationSuspected;
          if (suspicious) {
            failedWindows += 1;
            lastError = result.truncationSuspected
              ? `ASR output limit reached in window ${ordinal}`
              : `Speech-like audio returned no text in window ${ordinal}`;
          } else {
            completedWindows += 1;
          }

          if (text) {
            const blocks = await commitTranscriptFinalBlocks({
              meetingId: input.meetingId,
              text,
              segmentIndex: chunkIndex,
              startedAt: chunkCursorAt + window.startMs,
              endedAt: chunkCursorAt + window.endMs,
              language: result.language || 'auto',
            });
            input.onBlocks?.(blocks);
            previousText = rawText;
          }

          await updateMeeting(input.meetingId, {
            transcribedSegments: completedWindows,
            lastError,
          });
          log[suspicious ? 'warn' : 'info']('asr', 'qwen window processed', {
            meetingId: input.meetingId,
            chunkIndex,
            windowIndex,
            startMs: window.startMs,
            endMs: window.endMs,
            processingMs: result.processingMs,
            language: result.language,
            words: transcriptWordCount(text),
            rmsDbfs: result.rmsDbfs,
            peakDbfs: result.peakDbfs,
            tokenCount: result.tokenCount,
            suspicious,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          failedWindows += 1;
          lastError = message;
          await updateMeeting(input.meetingId, { lastError: message });
          log.error('asr', 'qwen window transcription failed', {
            meetingId: input.meetingId,
            chunkIndex,
            windowIndex,
            startMs: window.startMs,
            endMs: window.endMs,
            err: message,
          });
        }
      }
      chunkCursorAt += durationMs;
    }
  } finally {
    await releaseQwenAsr().catch(() => {});
  }

  const summary = await getTranscriptSummary(input.meetingId);
  const coverageComplete = windowCount > 0 && failedWindows === 0 && completedWindows === windowCount;
  const finalError = coverageComplete ? null : (lastError ?? 'Local transcription coverage is incomplete.');
  await updateMeeting(input.meetingId, {
    status: summary.hasText && coverageComplete ? 'transcribed' : 'recorded',
    language: 'auto',
    transcribedSegments: completedWindows,
    lastError: finalError,
  });
  return {
    hasText: summary.hasText,
    wordCount: summary.wordCount,
    blockCount: summary.blockCount,
    chunkCount: chunks.length,
    windowCount,
    completedWindows,
    failedWindows,
    coverageComplete,
    recoveredChunks: inspection.recoveredCount,
    lastError: finalError,
  };
}
