export const IOS_ASR_MAX_RECOVERY_ROUNDS = 3;

export function iosAsrRetryDelayMs(recoveryRounds: number): number | null {
  if (recoveryRounds <= 0) return 0;
  if (recoveryRounds === 1) return 20 * 60 * 1_000;
  if (recoveryRounds === 2) return 60 * 60 * 1_000;
  return null;
}

export function isIOSAsrRetryDue(input: {
  recoveryRounds: number;
  updatedAt: number;
  now: number;
}): boolean {
  const delay = iosAsrRetryDelayMs(input.recoveryRounds);
  return delay != null && input.now - input.updatedAt >= delay;
}
