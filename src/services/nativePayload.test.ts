import { describe, expect, it } from 'vitest';

import { compactNativeValue } from './nativePayload';

describe('compactNativeValue', () => {
  it('removes nullable values recursively before the Expo Kotlin bridge', () => {
    expect(compactNativeValue({
      meetingId: null,
      payload: { averageConfidence: null, words: 12 },
      alternatives: ['en-IN', null, 'hi-IN'],
    })).toEqual({
      payload: { words: 12 },
      alternatives: ['en-IN', 'hi-IN'],
    });
  });

  it('preserves zero, false, and empty strings', () => {
    expect(compactNativeValue({ zero: 0, no: false, empty: '' })).toEqual({ zero: 0, no: false, empty: '' });
  });
});
