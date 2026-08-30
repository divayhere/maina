export type IOSContinuedProcessingHandleState = {
  requestId: string;
  meetingId: string;
  asrGeneration: number | null;
  deferralRequested: boolean;
};

export type IOSContinuedProcessingDeferralIdentity = {
  requestId: string;
  meetingId: string;
  asrGeneration: number;
};

export function acceptIOSContinuedProcessingDeferral(
  handle: IOSContinuedProcessingHandleState | undefined,
  event: IOSContinuedProcessingDeferralIdentity,
): 'unowned' | 'accepted' | 'duplicate' | 'identity_mismatch' {
  if (!handle) return 'unowned';
  if (handle.requestId !== event.requestId || handle.meetingId !== event.meetingId) {
    return 'identity_mismatch';
  }
  if (handle.asrGeneration != null && handle.asrGeneration !== event.asrGeneration) {
    return 'identity_mismatch';
  }
  if (handle.deferralRequested) return 'duplicate';
  handle.deferralRequested = true;
  return 'accepted';
}
