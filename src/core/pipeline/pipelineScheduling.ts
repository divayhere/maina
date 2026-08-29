export const ACTIVE_PACKET_POLL_MS = 5_000;
export const MINIMUM_PACKET_RETRY_WAKE_MS = 1_000;

/** Poll active jobs quickly and wake exactly when durable retry work becomes due. */
export function nextPacketPollDelay(input: {
  pendingCount: number;
  appActive: boolean;
  nextRetryAt?: number | null;
  now?: number;
}): number | null {
  if (!input.appActive) return null;
  if (input.pendingCount > 0) return ACTIVE_PACKET_POLL_MS;
  if (input.nextRetryAt == null) return null;
  return Math.max(MINIMUM_PACKET_RETRY_WAKE_MS, input.nextRetryAt - (input.now ?? Date.now()));
}
