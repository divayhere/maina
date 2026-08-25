import { describe, expect, it } from 'vitest';

import { deriveNativeTranscriptOutcome, nativeProgress } from './nativePostProcessingCore';

describe('native transcript truth model', () => {
  it('does not promote a 190 of 216 transcript to complete or cloud-eligible', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: true,
      windowCount: 216,
      completedWindows: 190,
      failedWindows: 26,
      lastError: 'Speech-like audio returned no text.',
    })).toEqual({
      status: 'transcript_partial',
      coverageComplete: false,
      error: 'Speech-like audio returned no text.',
    });
  });

  it('promotes only complete non-empty coverage', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: true,
      windowCount: 216,
      completedWindows: 216,
      failedWindows: 0,
    })).toEqual({ status: 'transcribed', coverageComplete: true, error: null });
  });

  it('keeps audio recovery when complete windows contain no text', () => {
    expect(deriveNativeTranscriptOutcome({
      hasText: false,
      windowCount: 2,
      completedWindows: 2,
      failedWindows: 0,
    }).status).toBe('recorded');
  });

  it('reports persisted window progress without invented fallback values', () => {
    expect(nativeProgress({ windowCount: 216, completedWindows: 47, failedWindows: 1 }))
      .toEqual({ completed: 48, total: 216, ratio: 48 / 216 });
    expect(nativeProgress({ windowCount: 0, completedWindows: 0, failedWindows: 0 }).ratio)
      .toBeNull();
  });
});
