import { describe, expect, it, vi } from 'vitest';

import {
  notifyMeetingPipelineChanged,
  subscribeMeetingPipelineChanges,
} from './meetingPipelineSignals';

describe('meeting pipeline state signals', () => {
  it('reloads only while subscribed and carries no mutable state', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMeetingPipelineChanges(listener);

    notifyMeetingPipelineChanged('meeting-1');
    unsubscribe();
    notifyMeetingPipelineChanged('meeting-2');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('meeting-1');
  });
});
