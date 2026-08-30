import { describe, expect, it } from 'vitest';

import { acceptIOSContinuedProcessingDeferral } from './iosContinuedProcessingPolicy';

describe('iOS continued-processing deferral identity', () => {
  it('accepts the exact submission and ASR generation once', () => {
    const handle = {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 7,
      deferralRequested: false,
    };
    const event = { requestId: 'submission-a', meetingId: 'meeting-a', asrGeneration: 7 };
    expect(acceptIOSContinuedProcessingDeferral(handle, event)).toBe('accepted');
    expect(handle.deferralRequested).toBe(true);
    expect(acceptIOSContinuedProcessingDeferral(handle, event)).toBe('duplicate');
  });

  it('rejects a late callback from an older generation', () => {
    const handle = {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 8,
      deferralRequested: false,
    };
    expect(acceptIOSContinuedProcessingDeferral(handle, {
      requestId: 'submission-a',
      meetingId: 'meeting-a',
      asrGeneration: 7,
    })).toBe('identity_mismatch');
    expect(handle.deferralRequested).toBe(false);
  });

  it('allows native-only recovery to fence an unowned persisted generation', () => {
    expect(acceptIOSContinuedProcessingDeferral(undefined, {
      requestId: 'submission-after-relaunch',
      meetingId: 'meeting-a',
      asrGeneration: 9,
    })).toBe('unowned');
  });
});
