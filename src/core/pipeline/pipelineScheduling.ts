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
