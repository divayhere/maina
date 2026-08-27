import { describe, expect, it } from 'vitest';

import { ACTIVE_PACKET_POLL_MS, nextPacketPollDelay } from './pipelineScheduling';

describe('pipeline scheduling', () => {
  it('does not poll while there is no cloud work', () => expect(nextPacketPollDelay(0, true)).toBeNull());
  it('does not poll while the app is backgrounded', () => expect(nextPacketPollDelay(1, false)).toBeNull());
  it('polls only an active pending cloud job', () => expect(nextPacketPollDelay(1, true)).toBe(ACTIVE_PACKET_POLL_MS));
});
