import { describe, expect, it } from 'vitest';

import type { Meeting } from '@/data/meetings';
import {
  didTranscriptCoverageImprove,
  formatCoveragePercent,
  isTerminalNoSpeechMeeting,
  isTerminalPartialTranscript,
  isRecoveryBudgetExhausted,
  transcriptCoverage,
} from './transcriptCoverage';

const meeting = (patch: Partial<Meeting> = {}): Meeting => ({
  id: 'm1', title: 'Meeting', startedAt: 1, durationMs: 1, audioDurationMs: 1,
  decisions: [], openQuestions: [], status: 'transcript_partial', summaryStatus: 'idle',
  segmentCount: 1, transcribedSegments: 1, transcriptionWindowCount: 645,
  transcriptionCompletedWindows: 644, transcriptionFailedWindows: 1,
  transcriptionRecoveryRounds: 3, openTodoCount: 0, totalTodoCount: 0,
  updatedAt: 1, restartCount: 0, knowledgeCloudSyncStatus: 'local_only', ...patch,
});

describe('transcript coverage policy', () => {
  it('reports completed-audio coverage rather than transcription accuracy', () => {
    const coverage = transcriptCoverage(meeting());
    expect(coverage).toMatchObject({ completed: 644, failed: 1, checked: 645, total: 645 });
    expect(formatCoveragePercent(coverage.ratio)).toBe('99.8%');
  });

  it('recognizes a bounded terminal partial without making it cloud-eligible', () => {
    expect(isTerminalPartialTranscript(meeting())).toBe(true);
  });

  it('keeps a partial transcript recovering until the retry budget is exhausted', () => {
    expect(isTerminalPartialTranscript(meeting({ transcriptionRecoveryRounds: 2 }))).toBe(false);
  });

  it('does not treat materially incomplete coverage as a normal terminal transcript', () => {
    const damaged = meeting({
      transcriptionWindowCount: 100,
      transcriptionCompletedWindows: 90,
      transcriptionFailedWindows: 10,
    });
    expect(isRecoveryBudgetExhausted(damaged)).toBe(true);
    expect(isTerminalPartialTranscript(damaged)).toBe(false);
  });

  it('recognizes a fully checked recording with no speech text as terminal', () => {
    expect(isTerminalNoSpeechMeeting(meeting({
      status: 'recorded', transcriptionWindowCount: 2,
      transcriptionCompletedWindows: 2, transcriptionFailedWindows: 0,
    }))).toBe(true);
  });

  it('regenerates only after completed coverage increases', () => {
    expect(didTranscriptCoverageImprove(meeting(), meeting({
      transcriptionCompletedWindows: 645, transcriptionFailedWindows: 0,
    }))).toBe(true);
    expect(didTranscriptCoverageImprove(meeting(), meeting())).toBe(false);
  });
});
