type Listener = (meetingId: string) => void;

const listeners = new Set<Listener>();

export function notifyMeetingPacketChanged(meetingId: string): void {
  listeners.forEach((listener) => listener(meetingId));
}

export function subscribeMeetingPacketChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
