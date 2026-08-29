import type { Meeting, KnowledgeCloudSyncStatus } from '@/data/meetings';

export type MainaNotificationTone = 'warn' | 'info' | 'success';

export interface MainaNotification {
  id: string;
  meetingId: string;
  title: string;
  body: string;
  tone: MainaNotificationTone;
  createdAt: number;
  href: string;
  actionLabel: string;
  action: 'review_recovery' | 'retry_transcript' | 'retry_notes' | 'retry_cloud' | 'open_settings' | 'review_meeting';
}

function syncFailureCopy(status: KnowledgeCloudSyncStatus, error?: string | null) {
  switch (status) {
    case 'sync_failed_auth':
      return {
        title: 'Reconnect Maina Cloud',
        body: error ?? 'This phone needs to reconnect to Maina Cloud before it can continue syncing.',
      };
    case 'sync_failed_conflict':
      return {
        title: 'Cloud sync conflict',
        body: error ?? 'This meeting was frozen for sync earlier and now needs a deliberate retry path.',
      };
    case 'sync_failed_validation':
      return {
        title: 'Cloud sync needs fixing',
        body: error ?? 'Maina Knowledge Cloud rejected this meeting package.',
      };
    case 'sync_blocked_budget':
      return {
        title: 'Cloud sync paused',
        body: error ?? 'Cloud sync is blocked by plan or budget rules.',
      };
    case 'sync_failed_retryable':
      // A temporary network/server interruption is self-healing outbox state,
      // not a notification requiring the user to operate the pipeline.
      return null;
    default:
      return null;
  }
}

export function buildMainaNotifications(meetings: Meeting[]): MainaNotification[] {
  const notifications: MainaNotification[] = [];

  for (const meeting of meetings) {
    if (meeting.status === 'interrupted') {
      notifications.push({
        id: `interrupted:${meeting.id}`,
        meetingId: meeting.id,
        title: 'A recording was cut short',
        body: 'Saved audio or text is available for review.',
        tone: 'warn',
        createdAt: meeting.startedAt,
        href: `/meeting/${meeting.id}/recover`,
        actionLabel: 'Review options',
        action: 'review_recovery',
      });
    }

    if (meeting.status === 'transcript_partial') {
      notifications.push({
        id: `transcript-partial:${meeting.id}`,
        meetingId: meeting.id,
        title: 'Some audio needs another pass',
        body: 'Maina kept the saved audio and will retry when you choose.',
        tone: 'warn',
        createdAt: meeting.updatedAt ?? meeting.startedAt,
        href: `/meeting/${meeting.id}`,
        actionLabel: 'Retry now',
        action: 'retry_transcript',
      });
    }

    if (meeting.summaryStatus === 'failed') {
      notifications.push({
        id: `summary-failed:${meeting.id}`,
        meetingId: meeting.id,
        title: "Notes didn't come through",
        body: 'Your transcript is safe.',
        tone: 'warn',
        createdAt: meeting.updatedAt ?? meeting.startedAt,
        href: `/meeting/${meeting.id}`,
        actionLabel: 'Retry notes',
        action: 'retry_notes',
      });
    }

    const syncCopy = syncFailureCopy(meeting.knowledgeCloudSyncStatus, meeting.knowledgeCloudError);
    if (syncCopy) {
      const action = meeting.knowledgeCloudSyncStatus === 'sync_failed_auth'
        ? 'open_settings' as const
        : meeting.knowledgeCloudSyncStatus === 'sync_failed_retryable'
          ? 'retry_cloud' as const
          : 'review_meeting' as const;
      notifications.push({
        id: `cloud:${meeting.id}:${meeting.knowledgeCloudSyncStatus}`,
        meetingId: meeting.id,
        title: syncCopy.title,
        body: syncCopy.body,
        tone: 'warn',
        createdAt: meeting.knowledgeCloudLastAttemptAt ?? meeting.updatedAt ?? meeting.startedAt,
        href: action === 'open_settings' ? '/settings' : `/meeting/${meeting.id}`,
        actionLabel: action === 'open_settings'
          ? 'Open settings'
          : action === 'retry_cloud'
            ? 'Retry sync'
            : 'Review sync',
        action,
      });
    }
  }

  return notifications.sort((a, b) => {
    const toneScore = (tone: MainaNotificationTone) => (tone === 'warn' ? 0 : tone === 'info' ? 1 : 2);
    return toneScore(a.tone) - toneScore(b.tone) || b.createdAt - a.createdAt;
  });
}

export function countActionableNotifications(meetings: Meeting[]) {
  return buildMainaNotifications(meetings).filter((item) => item.tone === 'warn').length;
}
