import {
  NATIVE_CAPTURE_QUARANTINE_MESSAGE,
  deriveNativeCaptureStartupFence,
} from '@/core/recording/nativeCaptureStartupFence';
import { getMeeting, updateMeeting } from '@/data/meetings';
import { getNativeCaptureQuarantine, getPendingNativeDiscard } from '@/hardware/recording/foreground';

export type NativeCaptureAutomaticWorkFence = {
  protectedMeetingIds: readonly string[];
};

export function readNativeCaptureAutomaticWorkFence(): NativeCaptureAutomaticWorkFence {
  const fence = deriveNativeCaptureStartupFence(getNativeCaptureQuarantine());
  if (fence.state === 'blocked') throw new Error(NATIVE_CAPTURE_QUARANTINE_MESSAGE);
  return { protectedMeetingIds: fence.protectedMeetingIds };
}

export function readNativeCaptureDestructiveWorkFence(): NativeCaptureAutomaticWorkFence {
  const automaticFence = readNativeCaptureAutomaticWorkFence();
  const pendingDiscard = getPendingNativeDiscard();
  if (pendingDiscard.state === 'blocked') throw new Error(NATIVE_CAPTURE_QUARANTINE_MESSAGE);
  const protectedMeetingIds = new Set(automaticFence.protectedMeetingIds);
  if (pendingDiscard.state === 'pending' || pendingDiscard.state === 'ready_for_ack') {
    protectedMeetingIds.add(pendingDiscard.meetingId);
  }
  return { protectedMeetingIds: [...protectedMeetingIds] };
}

/**
 * Establishes the durable public boundary before any audio/path/diagnostic
 * enumeration. It deliberately does not inspect the protected capture.
 */
export async function establishNativeCaptureAutomaticWorkFence(): Promise<NativeCaptureAutomaticWorkFence> {
  const fence = readNativeCaptureAutomaticWorkFence();
  const meetingId = fence.protectedMeetingIds[0];
  if (!meetingId) return fence;
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error(NATIVE_CAPTURE_QUARANTINE_MESSAGE);
  if (meeting.status !== 'interrupted' || meeting.lastError !== NATIVE_CAPTURE_QUARANTINE_MESSAGE) {
    await updateMeeting(meetingId, {
      status: 'interrupted',
      lastError: NATIVE_CAPTURE_QUARANTINE_MESSAGE,
    });
  }
  return fence;
}
