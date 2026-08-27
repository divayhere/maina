import type { Meeting } from '@/data/meetings';

export type MeetingPresentationPhase =
  | 'recording'
  | 'recovery'
  | 'transcribing'
  | 'transcript_partial'
  | 'summary'
  | 'summary_failed'
  | 'complete';

export interface MeetingPresentation {
  phase: MeetingPresentationPhase;
  label: string;
  tone: 'primary' | 'warn' | 'live' | 'muted';
  detail?: string;
  working: boolean;
  progress?: number;
  canRetryTranscript: boolean;
}

function transcriptionProgress(meeting: Meeting): Pick<MeetingPresentation, 'detail' | 'progress'> {
  if (meeting.transcriptionWindowCount > 0) {
    const checked = Math.min(
      meeting.transcriptionWindowCount,
      Math.max(0, meeting.transcriptionCompletedWindows + meeting.transcriptionFailedWindows),
    );
    const progress = checked / meeting.transcriptionWindowCount;
    return {
      detail: `${checked} of ${meeting.transcriptionWindowCount} audio windows checked`,
      progress,
    };
  }
  if (meeting.segmentCount > 0 && meeting.transcribedSegments > 0) {
    const completed = Math.min(meeting.segmentCount, Math.max(0, meeting.transcribedSegments));
    return {
      detail: `${completed} of ${meeting.segmentCount} audio files checked`,
      progress: completed / meeting.segmentCount,
    };
  }
  return { detail: 'Saved audio is waiting for local transcription.' };
}

/**
 * One truthful presentation of the durable meeting pipeline. UI surfaces must
 * not infer failure merely because ASR has not committed its first text block.
 */
export function describeMeetingPresentation(meeting: Meeting): MeetingPresentation {
  if (meeting.status === 'recording') {
    return {
      phase: 'recording', label: 'Recording now', tone: 'live', working: true, canRetryTranscript: false,
    };
  }
  if (meeting.status === 'interrupted') {
    return {
      phase: 'recovery',
      label: 'Recording was cut short',
      tone: 'warn',
      detail: 'Saved audio or text is available for review.',
      working: false,
      canRetryTranscript: false,
    };
  }
  if (meeting.status === 'transcript_partial') {
    return {
      phase: 'transcript_partial',
      label: 'Transcript needs recovery',
      tone: 'warn',
      detail: 'Some saved audio needs another transcription pass.',
      working: false,
      canRetryTranscript: true,
    };
  }
  if (meeting.status === 'audio_expired_incomplete') {
    return {
      phase: 'transcript_partial',
      label: 'Partial transcript saved',
      tone: 'warn',
      detail: 'The recovery audio reached its storage limit.',
      working: false,
      canRetryTranscript: false,
    };
  }
  if (meeting.status === 'recorded' || meeting.status === 'transcribing') {
    const progress = transcriptionProgress(meeting);
    return {
      phase: 'transcribing',
      label: meeting.status === 'recorded' ? 'Transcription queued' : 'Getting the text ready',
      tone: 'primary',
      detail: progress.detail,
      progress: progress.progress,
      working: true,
      canRetryTranscript: false,
    };
  }
  if (meeting.summaryStatus === 'failed') {
    return {
      phase: 'summary_failed',
      label: "Notes didn't come through",
      tone: 'warn',
      detail: 'Your transcript is safe.',
      working: false,
      canRetryTranscript: false,
    };
  }
  if (meeting.summaryStatus === 'queued' || meeting.summaryStatus === 'running' || meeting.status === 'summarizing') {
    return {
      phase: 'summary',
      label: 'Writing your notes',
      tone: 'primary',
      detail: 'You can leave this screen.',
      working: true,
      canRetryTranscript: false,
    };
  }
  if (meeting.summaryStatus === 'ready' || meeting.status === 'summarized') {
    return {
      phase: 'complete', label: 'Notes ready', tone: 'primary', working: false, canRetryTranscript: false,
    };
  }
  return {
    phase: 'complete', label: 'Transcript saved', tone: 'muted', working: false, canRetryTranscript: false,
  };
}
