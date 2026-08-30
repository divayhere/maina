import { describe, expect, it, vi } from 'vitest';

import { createEarlierDeadlineTimer, type TimerHandle } from './earlierDeadlineTimer';
import { packetPollSignalDelay } from './pipelineScheduling';

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

  it('coalesces the packet poll state signal instead of creating an orphan timer chain', () => {
    const callbacks: (() => void)[] = [];
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as TimerHandle;
    });
    const timer = createEarlierDeadlineTimer({
      now: () => 1_000,
      setTimer,
      clearTimer: vi.fn(),
      onDue: vi.fn(),
    });

    const selfSignalDelay = packetPollSignalDelay({ pollInFlight: true, appActive: false });
    if (selfSignalDelay != null) timer.arm(selfSignalDelay);
    expect(setTimer).not.toHaveBeenCalled();

    timer.arm(10_000);
    const duplicateSignalDelay = packetPollSignalDelay({ pollInFlight: false, appActive: false });
    if (duplicateSignalDelay != null) timer.arm(duplicateSignalDelay);

    expect(setTimer).toHaveBeenCalledOnce();
    expect(callbacks).toHaveLength(1);
  });
});
