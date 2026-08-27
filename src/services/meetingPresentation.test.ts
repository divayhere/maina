import { describe, expect, it } from 'vitest';

import type { Meeting } from '@/data/meetings';
import { describeMeetingPresentation } from './meetingPresentation';

const meeting: Meeting = {
  id: 'm1',
  title: 'Meeting',
  startedAt: 1,
  durationMs: 60_000,
  audioDurationMs: 60_000,
  decisions: [],
  openQuestions: [],
  status: 'transcribing',
  summaryStatus: 'idle',
  segmentCount: 1,
  transcribedSegments: 0,
  transcriptionWindowCount: 10,
  transcriptionCompletedWindows: 0,
  transcriptionFailedWindows: 0,
  transcriptionRecoveryRounds: 0,
  openTodoCount: 0,
  totalTodoCount: 0,
  updatedAt: 1,
  restartCount: 0,
  knowledgeCloudSyncStatus: 'local_only',
};

describe('meeting pipeline presentation', () => {
  it('never offers recovery while local transcription is still running', () => {
    expect(describeMeetingPresentation(meeting)).toMatchObject({
      phase: 'transcribing',
      label: 'Getting the text ready',
      working: true,
      canRetryTranscript: false,
      progress: 0,
    });
  });

  it('reports persisted window progress without claiming transcript completion', () => {
    expect(describeMeetingPresentation({
      ...meeting,
      transcriptionCompletedWindows: 6,
      transcriptionFailedWindows: 1,
    })).toMatchObject({
      detail: '7 of 10 audio windows checked',
      progress: 0.7,
      phase: 'transcribing',
    });
  });

  it('offers recovery only for a terminal partial transcript with retained audio', () => {
    expect(describeMeetingPresentation({
      ...meeting,
      status: 'transcript_partial',
      transcriptionWindowCount: 645,
      transcriptionCompletedWindows: 644,
      transcriptionFailedWindows: 1,
      transcriptionRecoveryRounds: 3,
    })).toMatchObject({
      phase: 'transcript_partial',
      working: false,
      canRetryTranscript: true,
      label: '99.8% processed',
    });
  });

  it('shows a terminal no-speech result instead of a permanent queue', () => {
    expect(describeMeetingPresentation({
      ...meeting,
      status: 'recorded',
      audioUri: '/audio',
      transcriptionWindowCount: 2,
      transcriptionCompletedWindows: 2,
      transcriptionFailedWindows: 0,
    })).toMatchObject({
      phase: 'no_speech',
      label: 'No speech detected',
      working: false,
      canRetryTranscript: true,
    });
  });

  it('keeps notes independent while a terminal partial transcript is summarized', () => {
    expect(describeMeetingPresentation({
      ...meeting,
      status: 'transcript_partial',
      summaryStatus: 'running',
      transcriptionCompletedWindows: 644,
      transcriptionFailedWindows: 1,
      transcriptionWindowCount: 645,
      transcriptionRecoveryRounds: 3,
    })).toMatchObject({ phase: 'summary', label: 'Writing your notes', working: true });
  });

  it('keeps cloud note failure independent from a successful transcript', () => {
    expect(describeMeetingPresentation({
      ...meeting,
      status: 'transcribed',
      summaryStatus: 'failed',
    })).toMatchObject({
      phase: 'summary_failed',
      label: "Notes didn't come through",
      canRetryTranscript: false,
    });
  });
});
