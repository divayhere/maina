import { describe, expect, it } from 'vitest';

import { ACCEPTABLE_CAPTURE_GAP_MS, materialCaptureGapError } from './captureGap';

describe('capture-gap presentation', () => {
  it('keeps ordinary route activation and switching gaps as telemetry only', () => {
    expect(materialCaptureGapError(0)).toBeNull();
    expect(materialCaptureGapError(436)).toBeNull();
    expect(materialCaptureGapError(ACCEPTABLE_CAPTURE_GAP_MS)).toBeNull();
  });

  it('surfaces only a material continuity loss', () => {
    expect(materialCaptureGapError(3_001)).toBe('Audio input was unavailable for 3001ms.');
  });

  it('does not turn invalid native telemetry into a user-facing error', () => {
    expect(materialCaptureGapError(Number.NaN)).toBeNull();
  });
});
