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

  throw new Error(
    `Native audio capture did not reach ${expected} within ${timeoutMs}ms (last state: ${lastStatus?.state ?? 'unavailable'})`,
  );
}
