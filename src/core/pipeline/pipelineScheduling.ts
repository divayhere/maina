export const ACTIVE_PACKET_POLL_MS = 5_000;

/** Poll only while a real cloud packet is pending and the UI runtime is active. */
export function nextPacketPollDelay(pendingCount: number, appActive: boolean): number | null {
  return pendingCount > 0 && appActive ? ACTIVE_PACKET_POLL_MS : null;
}
