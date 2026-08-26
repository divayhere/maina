import type { AsrResult, AudioWindow } from './types';

export type AsrQualityReason =
  | 'engine-failed'
  | 'pathological-repetition'
  | 'truncation-suspected'
  | 'invalid-window-coverage';

export interface AsrQualityAssessment {
  suspicious: boolean;
  reasons: AsrQualityReason[];
}

const normalise = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();

/**
 * A conservative detector for the specific failure classes that justify a
 * local retry. It does not pretend to measure semantic correctness.
 */
export function hasPathologicalRepetition(value: string): boolean {
  const words = normalise(value).split(' ').filter(Boolean);
  if (words.length < 8) return false;

  for (let unitSize = 1; unitSize <= Math.min(6, Math.floor(words.length / 3)); unitSize += 1) {
    for (let start = 0; start + unitSize * 3 <= words.length; start += 1) {
      const unit = words.slice(start, start + unitSize).join(' ');
      let repetitions = 1;
      while (
        start + (repetitions + 1) * unitSize <= words.length &&
        words.slice(start + repetitions * unitSize, start + (repetitions + 1) * unitSize).join(' ') === unit
      ) {
        repetitions += 1;
      }
      if (repetitions >= 3) return true;
    }
  }
  return false;
}

export function assessAsrResult(result: AsrResult): AsrQualityAssessment {
  const reasons: AsrQualityReason[] = [];
  const text = normalise(result.text);

  if (result.outcome === 'failed') reasons.push('engine-failed');
  // RMS-derived `speechExpected` is telemetry, not evidence that a person
  // spoke. Room tone and route noise routinely cross its threshold. The native
  // post-processing service owns blank-output recovery through the Silero VAD
  // gate; keeping this legacy controller conservative avoids marking an entire
  // meeting recoverable merely because a quiet/empty window was normal.
  if (result.diagnostics.repetitionSuspected || hasPathologicalRepetition(text)) {
    reasons.push('pathological-repetition');
  }
  if (result.diagnostics.truncationSuspected) reasons.push('truncation-suspected');
  if (result.request.window.endMs <= result.request.window.startMs) {
    reasons.push('invalid-window-coverage');
  }

  return { suspicious: reasons.length > 0, reasons };
}

export interface CoverageAssessment {
  complete: boolean;
  uncoveredWindows: AudioWindow[];
}

/** Every fixed capture window must reach a terminal ASR result before complete. */
export function assessCoverage(windows: AudioWindow[], results: AsrResult[]): CoverageAssessment {
  const terminalChunkIds = new Set(
    results
      .filter((result) => ['success', 'empty', 'failed', 'suspicious'].includes(result.outcome))
      .map((result) => result.request.window.chunkId),
  );
  const uncoveredWindows = windows.filter((window) => !terminalChunkIds.has(window.chunkId));
  return { complete: uncoveredWindows.length === 0, uncoveredWindows };
}
