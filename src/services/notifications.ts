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
}

function syncFailureCopy(status: KnowledgeCloudSyncStatus, error?: string | null) {
  switch (status) {
    case 'sync_failed_auth':
      return {
        title: 'Cloud token needs updating',
        body: error ?? 'Maina Knowledge Cloud rejected the saved access token. Update cloud settings and retry.',
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
      return {
        title: 'Cloud sync will need a retry',
        body: error ?? 'Maina kept the frozen meeting package and can retry it.',
      };
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
        body: 'Maina saved what it could. Review recovery and keep the usable audio.',
        tone: 'warn',
        createdAt: meeting.startedAt,
        href: `/meeting/${meeting.id}/recover`,
      });
    }

    if (meeting.summaryStatus === 'failed') {
      notifications.push({
        id: `summary-failed:${meeting.id}`,
        meetingId: meeting.id,
        title: "Notes didn't come through",
        body: 'Your transcript is safe. Open the meeting and retry the notes packet.',
        tone: 'warn',
        createdAt: meeting.updatedAt ?? meeting.startedAt,
        href: `/meeting/${meeting.id}`,
      });
    }

    const syncCopy = syncFailureCopy(meeting.knowledgeCloudSyncStatus, meeting.knowledgeCloudError);
    if (syncCopy) {
      notifications.push({
        id: `cloud:${meeting.id}:${meeting.knowledgeCloudSyncStatus}`,
        meetingId: meeting.id,
        title: syncCopy.title,
        body: syncCopy.body,
        tone: 'warn',
        createdAt: meeting.knowledgeCloudLastAttemptAt ?? meeting.updatedAt ?? meeting.startedAt,
        href: `/meeting/${meeting.id}`,
      });
    }

    if (meeting.summaryStatus === 'ready' && meeting.summary?.trim()) {
      notifications.push({
        id: `summary-ready:${meeting.id}`,
        meetingId: meeting.id,
        title: 'Notes ready',
        body: `${meeting.title} is ready to review, share, or sync.`,
        tone: 'success',
        createdAt: meeting.updatedAt ?? meeting.startedAt,
        href: `/meeting/${meeting.id}`,
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
