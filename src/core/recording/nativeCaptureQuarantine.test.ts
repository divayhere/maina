import { describe, expect, it } from 'vitest';

import { decodeNativeCaptureQuarantine } from '@/core/recording/nativeCaptureQuarantine';

describe('legacy native capture quarantine', () => {
  it('accepts only the exact closed legacy terminal representation', () => {
    expect(decodeNativeCaptureQuarantine({
      state: 'legacy_terminal',
      meetingId: 'meeting-1',
      reason: 'legacy_terminal_disposition_missing',
    })).toEqual({
      state: 'legacy_terminal',
      meetingId: 'meeting-1',
      reason: 'legacy_terminal_disposition_missing',
    });
    expect(decodeNativeCaptureQuarantine({ state: 'none' })).toEqual({ state: 'none' });
    expect(decodeNativeCaptureQuarantine({ state: 'blocked' })).toEqual({ state: 'blocked' });
  });

  it.each([
    undefined,
    null,
    [],
    { state: 'legacy_terminal', meetingId: 'meeting-1' },
    { state: 'legacy_terminal', meetingId: '../meeting-1', reason: 'legacy_terminal_disposition_missing' },
    { state: 'legacy_terminal', meetingId: 'meeting-1', reason: 'other' },
    { state: 'legacy_terminal', meetingId: 'meeting-1', reason: 'legacy_terminal_disposition_missing', extra: true },
    { state: 'none', meetingId: 'meeting-1' },
  ])('fails closed for malformed or open evidence %#', (raw) => {
    expect(decodeNativeCaptureQuarantine(raw)).toEqual({ state: 'blocked' });
  });
});
