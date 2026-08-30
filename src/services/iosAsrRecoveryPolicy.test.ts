import { describe, expect, it } from 'vitest';
import { IOS_ASR_MAX_RECOVERY_ROUNDS, iosAsrRetryDelayMs, isIOSAsrRetryDue } from './iosAsrRecoveryPolicy';

describe('iOS bounded ASR recovery policy', () => {
  it('uses one immediate opportunity followed by bounded 20 and 60 minute rounds', () => {
    expect(IOS_ASR_MAX_RECOVERY_ROUNDS).toBe(3);
    expect(iosAsrRetryDelayMs(0)).toBe(0);
    expect(iosAsrRetryDelayMs(1)).toBe(20 * 60 * 1_000);
    expect(iosAsrRetryDelayMs(2)).toBe(60 * 60 * 1_000);
    expect(iosAsrRetryDelayMs(3)).toBeNull();
  });

  it('resumes on foreground only when the persisted retry is due', () => {
    expect(isIOSAsrRetryDue({ recoveryRounds: 1, updatedAt: 1_000, now: 1_000 + 20 * 60 * 1_000 })).toBe(true);
    expect(isIOSAsrRetryDue({ recoveryRounds: 1, updatedAt: 1_000, now: 1_000 + 10 * 60 * 1_000 })).toBe(false);
    expect(isIOSAsrRetryDue({ recoveryRounds: 3, updatedAt: 1_000, now: Number.MAX_SAFE_INTEGER })).toBe(false);
  });
});
