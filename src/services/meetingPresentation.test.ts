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
    expect(describeMeetingPresentation({ ...meeting, status: 'transcript_partial' })).toMatchObject({
      phase: 'transcript_partial',
      working: false,
      canRetryTranscript: true,
    });
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
