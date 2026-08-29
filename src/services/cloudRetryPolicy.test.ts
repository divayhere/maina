import { describe, expect, it } from 'vitest';

import {
  cloudRetryDelayMs,
  cloudRetryDue,
  isRetryableCloudFailure,
  nextCloudRetry,
} from '@/services/cloudRetryPolicy';

function cloudError(status: number) {
  return Object.assign(new Error('cloud failure'), { name: 'MainaCloudApiError', status });
}

describe('cloud retry policy', () => {
  it('backs off quickly first and caps recurring retries at three hours', () => {
    expect(cloudRetryDelayMs(0)).toBe(15_000);
    expect(cloudRetryDelayMs(3)).toBe(15 * 60_000);
    expect(cloudRetryDelayMs(99)).toBe(3 * 60 * 60_000);
    expect(nextCloudRetry({ attemptCount: 1, now: 1_000 })).toEqual({
      attemptCount: 2,
      lastRetryAt: 1_000,
      nextRetryAt: 61_000,
    });
  });

  it('distinguishes transient transport/server failures from auth and validation', () => {
    expect(isRetryableCloudFailure(cloudError(0))).toBe(true);
    expect(isRetryableCloudFailure(cloudError(503))).toBe(true);
    expect(isRetryableCloudFailure(cloudError(429))).toBe(true);
    expect(isRetryableCloudFailure(cloudError(401))).toBe(false);
    expect(isRetryableCloudFailure(cloudError(422))).toBe(false);
  });

  it('runs only work whose durable due time has arrived', () => {
    expect(cloudRetryDue(null, 100)).toBe(true);
    expect(cloudRetryDue(99, 100)).toBe(true);
    expect(cloudRetryDue(101, 100)).toBe(false);
  });
});
