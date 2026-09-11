const MEETING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type StagingPurgeCandidate = {
  id: string;
  status: string;
};

/**
 * Keeps native-owned meetings outside bulk staging cleanup. The protected set
 * comes from the durable native authority, not service-process liveness.
 */
export function selectPurgeableStagingMeetingIds(
  meetings: readonly StagingPurgeCandidate[],
  protectedMeetingIds: readonly string[],
): readonly string[] {
  const protectedIds = new Set<string>();
  for (const meetingId of protectedMeetingIds) {
    if (!MEETING_ID.test(meetingId)) throw new Error('staging_purge_protected_identity_invalid');
    protectedIds.add(meetingId);
  }
  return meetings
    .filter((meeting) => meeting.status !== 'recording' && !protectedIds.has(meeting.id))
    .map((meeting) => meeting.id);
}
