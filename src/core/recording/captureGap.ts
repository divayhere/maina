/**
 * Route activation and input switching commonly introduce a short, harmless
 * gap. Keep that measurement in pipeline metadata, but only surface it as a
 * meeting error when it exceeds Maina's accepted continuity budget.
 */
export const ACCEPTABLE_CAPTURE_GAP_MS = 3_000;

export function materialCaptureGapError(captureGapMs: number): string | null {
  if (!Number.isFinite(captureGapMs) || captureGapMs <= ACCEPTABLE_CAPTURE_GAP_MS) return null;
  return `Audio input was unavailable for ${Math.round(captureGapMs)}ms.`;
}
