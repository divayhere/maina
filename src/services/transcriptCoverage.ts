import type { Meeting } from '@/data/meetings';

export const TERMINAL_PARTIAL_RECOVERY_ROUNDS = 3;
export const MIN_USABLE_PARTIAL_COVERAGE = 0.99;
export const MAX_USABLE_PARTIAL_MISSING_MS = 60_000;
const ESTIMATED_WINDOW_MS = 15_000;

export type TranscriptCoverage = {
  total: number;
  completed: number;
  failed: number;
  checked: number;
  ratio: number | null;
  checkedRatio: number | null;
};

export function transcriptCoverage(input: Pick<Meeting,
  | 'transcriptionWindowCount'
  | 'transcriptionCompletedWindows'
  | 'transcriptionFailedWindows'
>): TranscriptCoverage {
  const total = Math.max(0, input.transcriptionWindowCount);
  const completed = Math.min(total, Math.max(0, input.transcriptionCompletedWindows));
  const failed = Math.min(Math.max(0, total - completed), Math.max(0, input.transcriptionFailedWindows));
  const checked = Math.min(total, completed + failed);
  return {
    total,
    completed,
    failed,
    checked,
    ratio: total > 0 ? completed / total : null,
    checkedRatio: total > 0 ? checked / total : null,
  };
}

export function formatCoveragePercent(ratio: number | null): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const percent = Math.max(0, Math.min(100, ratio * 100));
  if (percent === 100) return '100%';
  return `${percent.toFixed(percent >= 99 ? 1 : 0)}%`;
}

export function isTerminalNoSpeechMeeting(meeting: Meeting): boolean {
  const coverage = transcriptCoverage(meeting);
  return meeting.status === 'recorded'
    && coverage.total > 0
    && coverage.completed === coverage.total
    && coverage.failed === 0;
}

export function isTerminalPartialTranscript(meeting: Meeting): boolean {
  const coverage = transcriptCoverage(meeting);
  return isRecoveryBudgetExhausted(meeting)
    && coverage.total > 0
    && coverage.completed > 0
    && (coverage.ratio ?? 0) >= MIN_USABLE_PARTIAL_COVERAGE
    && coverage.failed * ESTIMATED_WINDOW_MS <= MAX_USABLE_PARTIAL_MISSING_MS;
}

export function isRecoveryBudgetExhausted(meeting: Meeting): boolean {
  const coverage = transcriptCoverage(meeting);
  return meeting.status === 'transcript_partial'
    && coverage.total > 0
    && coverage.checked === coverage.total
    && (meeting.transcriptionRecoveryRounds ?? 0) >= TERMINAL_PARTIAL_RECOVERY_ROUNDS;
}

export function didTranscriptCoverageImprove(
  before: Pick<Meeting, 'transcriptionWindowCount' | 'transcriptionCompletedWindows' | 'transcriptionFailedWindows'>,
  after: Pick<Meeting, 'transcriptionWindowCount' | 'transcriptionCompletedWindows' | 'transcriptionFailedWindows'>,
): boolean {
  const previous = transcriptCoverage(before);
  const next = transcriptCoverage(after);
  if (next.total <= 0) return false;
  if (previous.total <= 0) return next.completed > 0;
  return next.completed / next.total > previous.completed / previous.total;
}
