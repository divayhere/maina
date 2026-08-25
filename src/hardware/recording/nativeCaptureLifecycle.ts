import type { NativeCaptureStatus } from '../../../modules/maina-recorder/src';

export interface NativeCaptureWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for the service-owned recorder to acknowledge a command. */
export async function waitForNativeCaptureState(
  getStatus: () => NativeCaptureStatus | null,
  expected: NativeCaptureStatus['state'],
  options: NativeCaptureWaitOptions = {},
): Promise<NativeCaptureStatus> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  const delay = options.delay ?? sleep;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = getStatus();

  while (Date.now() <= deadline) {
    lastStatus = getStatus();
    if (lastStatus?.state === expected) return lastStatus;
    if (lastStatus?.state === 'error') {
      throw new Error(lastStatus.lastError || 'Native audio capture failed');
    }
    await delay(pollMs);
  }

  // React Native's JS timers are not a clock that the foreground service can
  // rely on.  When Android parks the JS runtime on the lock screen, a timer
  // can wake up well after its nominal deadline.  Always take one fresh
  // native snapshot before declaring a timeout; otherwise a completed native
  // command gets reported as an error simply because JavaScript woke late.
  lastStatus = getStatus();
  if (lastStatus?.state === expected) return lastStatus;
  if (lastStatus?.state === 'error') {
    throw new Error(lastStatus.lastError || 'Native audio capture failed');
  }

  throw new Error(
    `Native audio capture did not reach ${expected} within ${timeoutMs}ms (last state: ${lastStatus?.state ?? 'unavailable'})`,
  );
}
