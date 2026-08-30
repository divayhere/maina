import { describe, expect, it } from 'vitest';
import type { Meeting } from '@/data/meetings';
import { buildMainaNotifications } from './notifications';

const baseMeeting = (overrides: Partial<Meeting> = {}): Meeting => ({
  id: 'meeting-1',
  title: 'Test meeting',
  startedAt: 1_700_000_000_000,
  durationMs: 60_000,
  audioDurationMs: 60_000,
  audioUri: null,
  transcript: 'Saved transcript',
  summary: 'Saved notes',
  decisions: [],
  openQuestions: [],
  language: 'en-IN',
  status: 'summarized',
  summaryStatus: 'ready',
  segmentCount: 1,
  transcribedSegments: 1,
  transcriptionWindowCount: 1,
  transcriptionCompletedWindows: 1,
  transcriptionFailedWindows: 0,
  transcriptionRecoveryRounds: 0,
  openTodoCount: 0,
  totalTodoCount: 0,
  updatedAt: 1_700_000_060_000,
  restartCount: 0,
  knowledgeCloudSyncStatus: 'sync_succeeded',
  nativePostprocessRunId: 'run-1',
  ...overrides,
});

describe('buildMainaNotifications', () => {
  it('keeps healthy completed meetings out of the attention inbox', () => {
    expect(buildMainaNotifications([baseMeeting()])).toEqual([]);
  });

  it('assigns a direct recovery action to an interrupted meeting', () => {
    const [notification] = buildMainaNotifications([baseMeeting({
      status: 'interrupted',
      summaryStatus: 'idle',
      summary: null,
      transcript: null,
      nativePostprocessRunId: null,
      knowledgeCloudSyncStatus: 'local_only',
    })]);
    expect(notification).toMatchObject({
      action: 'review_recovery',
      actionLabel: 'Review options',
      href: '/meeting/meeting-1/recover',
    });
  });

  it('routes retryable pipeline failures to their precise next action', () => {
    expect(buildMainaNotifications([baseMeeting({
      status: 'transcript_partial',
      summaryStatus: 'idle',
      summary: null,
      knowledgeCloudSyncStatus: 'local_only',
    })])).toEqual([]);

    expect(buildMainaNotifications([baseMeeting({
      summaryStatus: 'failed',
      knowledgeCloudSyncStatus: 'local_only',
    })])[0]).toMatchObject({
      action: 'retry_notes',
      actionLabel: 'Retry notes',
      href: '/meeting/meeting-1',
    });

    expect(buildMainaNotifications([baseMeeting({
      knowledgeCloudSyncStatus: 'sync_failed_auth',
    })])[0]).toMatchObject({
      action: 'open_settings',
      actionLabel: 'Open settings',
      href: '/settings',
    });
  });

  it('does not ask the user to operate self-healing network retries', () => {
    expect(buildMainaNotifications([baseMeeting({
      summaryStatus: 'retryable',
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
    })])).toEqual([]);
  });
});
