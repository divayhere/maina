import { describe, expect, it } from 'vitest';

import { recordingLevelFromDbfs } from './audioLevel';

describe('recording audio-level presentation', () => {
  it('stops completely when capture is not active', () => expect(recordingLevelFromDbfs(-20, false)).toBe(0));
  it('keeps an honest low activity floor while recording', () => expect(recordingLevelFromDbfs(-80, true)).toBe(0.06));
  it('makes ordinary quiet speech visibly stronger than the floor', () => expect(recordingLevelFromDbfs(-50, true)).toBeGreaterThan(0.45));
  it('clamps loud input to a safe maximum', () => expect(recordingLevelFromDbfs(0, true)).toBe(1));
});
