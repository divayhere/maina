type Listener = (meetingId: string) => void;

const listeners = new Set<Listener>();

/**
 * In-process hint that durable meeting state changed. SQLite remains the
 * source of truth; listeners always reload from it instead of consuming an
 * event payload that could become stale.
 */
export function notifyMeetingPipelineChanged(meetingId: string): void {
  listeners.forEach((listener) => listener(meetingId));
}

export function subscribeMeetingPipelineChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
