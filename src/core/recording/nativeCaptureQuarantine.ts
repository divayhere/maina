export type NativeCaptureQuarantine =
  | { state: 'none' | 'blocked' }
  | {
    state: 'legacy_terminal';
    meetingId: string;
    reason: 'legacy_terminal_disposition_missing';
  };

const NATIVE_CAPTURE_MEETING_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function decodeNativeCaptureQuarantine(raw: unknown): NativeCaptureQuarantine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'blocked' };
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if ((value.state === 'none' || value.state === 'blocked')
    && keys.length === 1 && keys[0] === 'state') {
    return { state: value.state };
  }
  if (value.state === 'legacy_terminal'
    && keys.join(',') === 'meetingId,reason,state'
    && typeof value.meetingId === 'string' && NATIVE_CAPTURE_MEETING_ID.test(value.meetingId)
    && value.reason === 'legacy_terminal_disposition_missing') {
    return {
      state: value.state,
      meetingId: value.meetingId,
      reason: value.reason,
    };
  }
  return { state: 'blocked' };
}
