import type { Meeting } from '@/data/meetings';

export function chooseSummaryProviderLabel(meeting: Meeting | null): string {
  if (!meeting?.summaryProviderId) return 'Maina Cloud';
  return meeting.summaryProviderId === 'maina-cloud' ? 'Maina Cloud' : 'Maina Cloud';
}
