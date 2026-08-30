export type TimerHandle = ReturnType<typeof setTimeout>;

export type EarlierDeadlineTimer = {
  arm(delayMs: number): boolean;
  cancel(): void;
  dueAt(): number | null;
  hasPending(): boolean;
};

/**
 * Owns one timer and only replaces it when the candidate deadline is earlier.
 * This prevents state-change hints from accumulating orphan poll timers while
 * still allowing genuinely new work to pre-empt a distant retry deadline.
 */
export function createEarlierDeadlineTimer(input: {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onDue: () => void;
}): EarlierDeadlineTimer {
  const now = input.now ?? Date.now;
  const setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = input.clearTimer ?? ((handle) => clearTimeout(handle));
  let handle: TimerHandle | null = null;
  let pendingDueAt: number | null = null;

  const cancel = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
    pendingDueAt = null;
  };

  return {
    arm(delayMs) {
      const boundedDelay = Math.max(0, delayMs);
      const candidateDueAt = now() + boundedDelay;
      if (handle !== null && pendingDueAt !== null && pendingDueAt <= candidateDueAt) {
        return false;
      }
      cancel();
      pendingDueAt = candidateDueAt;
      handle = setTimer(() => {
        handle = null;
        pendingDueAt = null;
        input.onDue();
      }, boundedDelay);
      return true;
    },
    cancel,
    dueAt: () => pendingDueAt,
    hasPending: () => handle !== null,
  };
}
