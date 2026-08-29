import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PACKET_POLL_MS,
  MINIMUM_PACKET_RETRY_WAKE_MS,
  nextPacketPollDelay,
} from './pipelineScheduling';

describe('pipeline scheduling', () => {
  it('does not poll while there is no cloud work', () => expect(nextPacketPollDelay({ pendingCount: 0, appActive: true })).toBeNull());
  it('does not poll while the app is backgrounded', () => expect(nextPacketPollDelay({ pendingCount: 1, appActive: false })).toBeNull());
  it('polls an active pending cloud job', () => expect(nextPacketPollDelay({ pendingCount: 1, appActive: true })).toBe(ACTIVE_PACKET_POLL_MS));
  it('wakes when durable retry work becomes due instead of dropping the retry', () => {
    expect(nextPacketPollDelay({
      pendingCount: 0,
      appActive: true,
      nextRetryAt: 61_000,
      now: 1_000,
    })).toBe(60_000);
    expect(nextPacketPollDelay({
      pendingCount: 0,
      appActive: true,
      nextRetryAt: 999,
      now: 1_000,
    })).toBe(MINIMUM_PACKET_RETRY_WAKE_MS);
  });
});
