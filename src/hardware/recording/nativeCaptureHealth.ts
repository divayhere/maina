import type { NativeCaptureStatus } from '../../../modules/maina-recorder/src';

export const NATIVE_CAPTURE_STALL_MS = 90_000;

export function isNativeCaptureStalled(
  status: NativeCaptureStatus | null | undefined,
  nowMs: number,
  stallMs = NATIVE_CAPTURE_STALL_MS,
): boolean {
  if (!status || status.state !== 'recording') return false;
  const lastProgressAtMs = status.lastProgressAtMs;
  if (typeof lastProgressAtMs !== 'number' || !Number.isFinite(lastProgressAtMs) || lastProgressAtMs <= 0) {
    return false;
  }
  return nowMs - lastProgressAtMs >= stallMs;
}
