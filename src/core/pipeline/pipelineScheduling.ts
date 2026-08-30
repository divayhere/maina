export const ACTIVE_PACKET_POLL_MS = 5_000;
export const BACKGROUND_PACKET_POLL_MS = 10_000;
export const MINIMUM_PACKET_RETRY_WAKE_MS = 1_000;

/**
 * Poll while a real job exists even when the UI is backgrounded. The timer can
 * run only while Android or an iOS continued/background task owns execution;
 * persisted retries remain the fallback after suspension or process death.
 */
export function nextPacketPollDelay(input: {
  pendingCount: number;
  appActive: boolean;
  nextRetryAt?: number | null;
  now?: number;
}): number | null {
  if (input.pendingCount > 0) {
    return input.appActive ? ACTIVE_PACKET_POLL_MS : BACKGROUND_PACKET_POLL_MS;
  }
  if (input.nextRetryAt == null) return null;
  return Math.max(MINIMUM_PACKET_RETRY_WAKE_MS, input.nextRetryAt - (input.now ?? Date.now()));
}

export function packetPollSignalDelay(input: {
  appActive: boolean;
}): number {
  return input.appActive ? ACTIVE_PACKET_POLL_MS : BACKGROUND_PACKET_POLL_MS;
}

export type PacketPollSignalDisposition = 'deferred' | 'scheduled' | 'coalesced' | 'stopped';

/**
 * Coalesces generic meeting-pipeline hints without trying to infer their origin.
 * A hint observed during an active reconciliation is retained as one dirty bit;
 * the active owner consumes it only after releasing the in-flight slot. This
 * closes the read-window race for newly queued work while preventing self-signal
 * bursts from creating parallel timer chains.
 */
export function createPacketPollSignalCoalescer(input: {
  isPollInFlight: () => boolean;
  appActive: () => boolean;
  arm: (delayMs: number) => boolean;
}): {
  signal(): PacketPollSignalDisposition;
  pollSettled(): boolean;
  cancel(): void;
  hasDeferredSignal(): boolean;
} {
  let deferredSignal = false;
  let stopped = false;

  const armBoundedSuccessor = () => input.arm(packetPollSignalDelay({ appActive: input.appActive() }));

  return {
    signal() {
      if (stopped) return 'stopped';
      if (input.isPollInFlight()) {
        deferredSignal = true;
        return 'deferred';
      }
      return armBoundedSuccessor() ? 'scheduled' : 'coalesced';
    },
    pollSettled() {
      if (stopped || !deferredSignal) return false;
      deferredSignal = false;
      armBoundedSuccessor();
      return true;
    },
    cancel() {
      stopped = true;
      deferredSignal = false;
    },
    hasDeferredSignal: () => deferredSignal,
  };
}
