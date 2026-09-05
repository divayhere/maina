import { describe, expect, it } from 'vitest';

import { recordingSaveHandoff } from './saveHandoff';

describe('recordingSaveHandoff', () => {
  it('leaves native finalizing and idle publication to the STOP or ABORT owner before JS can be interrupted', () => {
    expect(recordingSaveHandoff('native-qwen')).toBe('native-terminal-owner');
  });

  it('keeps non-native saving as a separate React presentation concern', () => {
    expect(recordingSaveHandoff('speech-recognition')).toBe('legacy-js-presentation');
  });
});
