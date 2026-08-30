import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PACKET_POLL_MS,
  BACKGROUND_PACKET_POLL_MS,
  MINIMUM_PACKET_RETRY_WAKE_MS,
  nextPacketPollDelay,
  packetPollSignalDelay,
} from './pipelineScheduling';

describe('pipeline scheduling', () => {
  it('does not poll while there is no cloud work', () => expect(nextPacketPollDelay({ pendingCount: 0, appActive: true })).toBeNull());
  it('keeps one bounded poll chain alive while OS background execution is available', () => {
    expect(nextPacketPollDelay({ pendingCount: 1, appActive: false })).toBe(BACKGROUND_PACKET_POLL_MS);
  });
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

  it('does not let a packet poll wake itself while its owner is still active', () => {
    expect(packetPollSignalDelay({ pollInFlight: true, appActive: true })).toBeNull();
    expect(packetPollSignalDelay({ pollInFlight: true, appActive: false })).toBeNull();
  });

  it('uses the bounded platform interval for a state signal outside the active poll', () => {
    expect(packetPollSignalDelay({ pollInFlight: false, appActive: true })).toBe(ACTIVE_PACKET_POLL_MS);
    expect(packetPollSignalDelay({ pollInFlight: false, appActive: false })).toBe(BACKGROUND_PACKET_POLL_MS);
  });
});
