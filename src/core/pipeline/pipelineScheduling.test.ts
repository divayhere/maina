import { describe, expect, it } from 'vitest';

import {
  ACTIVE_PACKET_POLL_MS,
  BACKGROUND_PACKET_POLL_MS,
  MINIMUM_PACKET_RETRY_WAKE_MS,
  createPacketPollSignalCoalescer,
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

  it('uses the bounded platform interval for a packet state signal', () => {
    expect(packetPollSignalDelay({ appActive: true })).toBe(ACTIVE_PACKET_POLL_MS);
    expect(packetPollSignalDelay({ appActive: false })).toBe(BACKGROUND_PACKET_POLL_MS);
  });

  it('retains one dirty hint while a poll is active and consumes it after release', () => {
    let pollInFlight = true;
    const armed: number[] = [];
    const coalescer = createPacketPollSignalCoalescer({
      isPollInFlight: () => pollInFlight,
      appActive: () => false,
      arm: (delayMs) => { armed.push(delayMs); return true; },
    });

    expect(coalescer.signal()).toBe('deferred');
    expect(coalescer.signal()).toBe('deferred');
    expect(coalescer.hasDeferredSignal()).toBe(true);
    expect(armed).toEqual([]);

    pollInFlight = false;
    expect(coalescer.pollSettled()).toBe(true);
    expect(coalescer.pollSettled()).toBe(false);
    expect(coalescer.hasDeferredSignal()).toBe(false);
    expect(armed).toEqual([BACKGROUND_PACKET_POLL_MS]);
  });
});
