import { describe, expect, it, vi } from 'vitest';

import { createEarlierDeadlineTimer, type TimerHandle } from './earlierDeadlineTimer';
import {
  BACKGROUND_PACKET_POLL_MS,
  createPacketPollSignalCoalescer,
} from './pipelineScheduling';

describe('earlier deadline timer', () => {
  it('keeps one timer when an equal or later deadline is requested', () => {
    let now = 1_000;
    const scheduled = new Map<number, () => void>();
    let nextHandle = 1;
    const clearTimer = vi.fn((handle: TimerHandle) => scheduled.delete(Number(handle)));
    const setTimer = vi.fn((callback: () => void) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle as unknown as TimerHandle;
    });
    const timer = createEarlierDeadlineTimer({ now: () => now, setTimer, clearTimer, onDue: vi.fn() });

    expect(timer.arm(10_000)).toBe(true);
    now = 2_000;
    expect(timer.arm(9_000)).toBe(false);
    expect(timer.arm(20_000)).toBe(false);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(clearTimer).not.toHaveBeenCalled();
    expect(scheduled.size).toBe(1);
  });

  it('replaces a distant retry timer only when genuinely earlier work arrives', () => {
    let now = 1_000;
    const scheduled = new Map<number, () => void>();
    let nextHandle = 1;
    const clearTimer = vi.fn((handle: TimerHandle) => scheduled.delete(Number(handle)));
    const setTimer = vi.fn((callback: () => void) => {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle as unknown as TimerHandle;
    });
    const timer = createEarlierDeadlineTimer({ now: () => now, setTimer, clearTimer, onDue: vi.fn() });

    expect(timer.arm(3 * 60 * 60_000)).toBe(true);
    now = 2_000;
    expect(timer.arm(5_000)).toBe(true);
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(clearTimer).toHaveBeenCalledOnce();
    expect(scheduled.size).toBe(1);
    expect(timer.dueAt()).toBe(7_000);
  });

  it('clears ownership before the callback and permits exactly one successor', () => {
    const callbacks: (() => void)[] = [];
    const onDue = vi.fn();
    const timer = createEarlierDeadlineTimer({
      now: () => 1_000,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as TimerHandle;
      },
      clearTimer: vi.fn(),
      onDue,
    });

    timer.arm(5_000);
    callbacks[0]!();

    expect(onDue).toHaveBeenCalledOnce();
    expect(timer.hasPending()).toBe(false);
    expect(timer.arm(5_000)).toBe(true);
    expect(callbacks).toHaveLength(2);
  });

  it('turns many in-flight self-signals into one bounded successor', () => {
    let pollInFlight = true;
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const setTimer = vi.fn((callback: () => void) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle as unknown as TimerHandle;
    });
    const timer = createEarlierDeadlineTimer({
      now: () => 1_000,
      setTimer,
      clearTimer: (handle) => { callbacks.delete(Number(handle)); },
      onDue: vi.fn(),
    });
    const signals = createPacketPollSignalCoalescer({
      isPollInFlight: () => pollInFlight,
      appActive: () => false,
      arm: timer.arm,
    });

    for (let index = 0; index < 100; index += 1) signals.signal();
    expect(setTimer).not.toHaveBeenCalled();
    expect(signals.hasDeferredSignal()).toBe(true);

    // The active reconciliation may already arm its normal successor. Releasing
    // the dirty hint must reuse that equal deadline, not create another timer.
    timer.arm(BACKGROUND_PACKET_POLL_MS);
    pollInFlight = false;
    expect(signals.pollSettled()).toBe(true);

    expect(setTimer).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);
  });

  it('retains a newly queued external meeting across the active read window', () => {
    let pollInFlight = true;
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const onDue = vi.fn();
    const timer = createEarlierDeadlineTimer({
      now: () => 1_000,
      setTimer: (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle as unknown as TimerHandle;
      },
      clearTimer: (handle) => { callbacks.delete(Number(handle)); },
      onDue,
    });
    const signals = createPacketPollSignalCoalescer({
      isPollInFlight: () => pollInFlight,
      appActive: () => false,
      arm: timer.arm,
    });

    // The active read found no pending rows, then a different meeting queued.
    expect(signals.signal()).toBe('deferred');
    expect(timer.hasPending()).toBe(false);
    pollInFlight = false;
    expect(signals.pollSettled()).toBe(true);
    expect(callbacks.size).toBe(1);

    [...callbacks.values()][0]!();
    expect(onDue).toHaveBeenCalledOnce();
    expect(timer.hasPending()).toBe(false);
  });

  it('cancels both pending timer and dirty signal ownership during cleanup', () => {
    let pollInFlight = true;
    const callbacks = new Map<number, () => void>();
    const clearTimer = vi.fn((handle: TimerHandle) => { callbacks.delete(Number(handle)); });
    const timer = createEarlierDeadlineTimer({
      now: () => 1_000,
      setTimer: (callback) => {
        callbacks.set(1, callback);
        return 1 as unknown as TimerHandle;
      },
      clearTimer,
      onDue: vi.fn(),
    });
    const signals = createPacketPollSignalCoalescer({
      isPollInFlight: () => pollInFlight,
      appActive: () => false,
      arm: timer.arm,
    });

    signals.signal();
    timer.arm(BACKGROUND_PACKET_POLL_MS);
    signals.cancel();
    timer.cancel();
    pollInFlight = false;

    expect(signals.hasDeferredSignal()).toBe(false);
    expect(signals.pollSettled()).toBe(false);
    expect(signals.signal()).toBe('stopped');
    expect(callbacks.size).toBe(0);
    expect(clearTimer).toHaveBeenCalledOnce();
  });
});
