import type { Meeting } from '@/data/meetings';
import { getProvider } from '@/core/summarization/providers';

export function chooseSummaryProviderLabel(meeting: Meeting | null): string {
  if (!meeting?.summaryProviderId) return 'your chosen AI provider';
  return getProvider(meeting.summaryProviderId)?.label ?? meeting.summaryProviderId;
}
