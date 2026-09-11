import type { NativeCaptureQuarantine } from './nativeCaptureQuarantine';

export const NATIVE_CAPTURE_QUARANTINE_MESSAGE =
  'A previous recording needs an explicit recovery choice before automatic audio work can continue.';

export type NativeCaptureStartupFence =
  | { state: 'clear'; protectedMeetingIds: readonly [] }
  | { state: 'blocked'; protectedMeetingIds: readonly [] }
  | { state: 'legacy_terminal'; protectedMeetingIds: readonly [string] };

/**
 * Pure boundary between closed native ownership evidence and automatic JS work.
 * A legacy terminal owner protects exactly one meeting; malformed evidence
 * freezes recovery globally rather than guessing which audio is safe to touch.
 */
export function deriveNativeCaptureStartupFence(
  quarantine: NativeCaptureQuarantine,
): NativeCaptureStartupFence {
  if (quarantine.state === 'blocked') return { state: 'blocked', protectedMeetingIds: [] };
  if (quarantine.state === 'legacy_terminal') {
    return { state: 'legacy_terminal', protectedMeetingIds: [quarantine.meetingId] };
  }
  return { state: 'clear', protectedMeetingIds: [] };
}
