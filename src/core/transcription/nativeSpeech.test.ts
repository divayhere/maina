import { describe, expect, it } from 'vitest';

import { selectRecognitionLanguage } from './languageSelection';

describe('selectRecognitionLanguage', () => {
  it('prefers Indian English when both core models are installed', () => {
    expect(selectRecognitionLanguage(['hi-IN', 'en-IN'])).toBe('en-IN');
  });

  it('uses Hindi when it is the only core model installed', () => {
    expect(selectRecognitionLanguage(['HI-in'])).toBe('hi-IN');
  });

  it('keeps US English only as an emergency installed fallback', () => {
    expect(selectRecognitionLanguage(['fr-FR', 'en-US'])).toBe('en-US');
  });

  it('reports no usable model instead of inventing an installed locale', () => {
    expect(selectRecognitionLanguage(['fr-FR'])).toBeNull();
  });
});
