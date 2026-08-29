const RETRY_DELAYS_MS = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
] as const;

export function cloudRetryDelayMs(attemptCount: number): number {
  const index = Math.min(Math.max(0, attemptCount), RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index];
}

export function cloudRetryDue(nextRetryAt: number | null | undefined, now = Date.now()): boolean {
  return nextRetryAt == null || nextRetryAt <= now;
}

export function isRetryableCloudFailure(error: unknown): boolean {
  const cloudError = error as { name?: unknown; status?: unknown } | null;
  if (typeof cloudError?.status === 'number') {
    return cloudError.status === 0
      || cloudError.status === 408
      || cloudError.status === 425
      || cloudError.status === 429
      || cloudError.status >= 500;
  }
  // Parsing or malformed-success errors are safe to retry because meeting
  // packet creation is idempotent by its stable source and packet version.
  return true;
}

export function nextCloudRetry(input: { attemptCount: number; now?: number }) {
  const now = input.now ?? Date.now();
  const attemptCount = Math.max(0, input.attemptCount) + 1;
  return {
    attemptCount,
    lastRetryAt: now,
    nextRetryAt: now + cloudRetryDelayMs(input.attemptCount),
  };
}
