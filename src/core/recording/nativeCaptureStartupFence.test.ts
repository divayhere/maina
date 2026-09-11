import { describe, expect, it } from 'vitest';

import {
  NATIVE_CAPTURE_QUARANTINE_MESSAGE,
  deriveNativeCaptureStartupFence,
} from './nativeCaptureStartupFence';

describe('native capture automatic-work fence', () => {
  it('allows ordinary startup only for exact none evidence', () => {
    expect(deriveNativeCaptureStartupFence({ state: 'none' })).toEqual({
      state: 'clear',
      protectedMeetingIds: [],
    });
  });

  it('protects the exact legacy terminal meeting without inspecting audio', () => {
    expect(deriveNativeCaptureStartupFence({
      state: 'legacy_terminal',
      meetingId: 'meeting-legacy',
      reason: 'legacy_terminal_disposition_missing',
    })).toEqual({
      state: 'legacy_terminal',
      protectedMeetingIds: ['meeting-legacy'],
    });
  });

  it('freezes automatic recovery when native ownership evidence is blocked', () => {
    expect(deriveNativeCaptureStartupFence({ state: 'blocked' })).toEqual({
      state: 'blocked',
      protectedMeetingIds: [],
    });
    expect(NATIVE_CAPTURE_QUARANTINE_MESSAGE).not.toMatch(/meeting[-_ ]?id|file:|\/private\/|transcript/i);
  });
});
