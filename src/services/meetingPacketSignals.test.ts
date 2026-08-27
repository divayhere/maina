import { describe, expect, it, vi } from 'vitest';
import { notifyMeetingPacketChanged, subscribeMeetingPacketChanges } from './meetingPacketSignals';

describe('meeting packet poll signals', () => {
  it('wakes active subscribers once and unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMeetingPacketChanges(listener);
    notifyMeetingPacketChanged('meeting-1');
    unsubscribe();
    notifyMeetingPacketChanged('meeting-2');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('meeting-1');
  });
});
