import { describe, expect, it } from 'vitest';

import { getProvider } from '../core/summarization/providers';
import { providerValidationInternal } from './providerValidation';

describe('providerValidationInternal.pickPreferredModel', () => {
  it('prefers the provider default model when it is available', () => {
    const provider = getProvider('gemini');
    expect(provider).toBeTruthy();
    expect(
      providerValidationInternal.pickPreferredModel(
        provider!,
        ['gemini-3.6-flash', 'gemini-2.5-pro'],
        '',
      ),
    ).toBe('gemini-3.6-flash');
  });

  it('honors a requested model when it is available', () => {
    const provider = getProvider('gemini');
    expect(provider).toBeTruthy();
    expect(
      providerValidationInternal.pickPreferredModel(
        provider!,
        ['gemini-3.6-flash', 'gemini-2.5-pro'],
        'gemini-2.5-pro',
      ),
    ).toBe('gemini-2.5-pro');
  });

  it('falls back to the first available model when provider defaults are missing', () => {
    const provider = getProvider('deepseek');
    expect(provider).toBeTruthy();
    expect(
      providerValidationInternal.pickPreferredModel(
        provider!,
        ['deepseek-v4-flash', 'deepseek-v4-pro'],
        '',
      ),
    ).toBe('deepseek-v4-flash');
  });

  it('builds a stable preferred order before falling back', () => {
    const provider = getProvider('gemini');
    expect(provider).toBeTruthy();
    expect(
      providerValidationInternal.buildModelPreferenceOrder(
        provider!,
        ['gemini-2.5-pro', 'gemini-3.6-flash', 'gemini-3.5-flash'],
        '',
      ),
    ).toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-pro']);
  });
});

describe('providerValidationInternal.normalizeBaseUrl', () => {
  it('trims spaces and trailing slashes', () => {
    expect(
      providerValidationInternal.normalizeBaseUrl(' https://api.example.com/v1/ '),
    ).toBe('https://api.example.com/v1');
  });
});
