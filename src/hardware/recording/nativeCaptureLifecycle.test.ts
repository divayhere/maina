import { describe, expect, it, vi } from 'vitest';

import { waitForNativeCaptureState } from './nativeCaptureLifecycle';

describe('native capture command acknowledgement', () => {
  it('waits through stale and transitional states', async () => {
    const states = ['idle', 'starting', 'recording'] as const;
    let index = 0;
    const result = await waitForNativeCaptureState(
      () => ({ state: states[Math.min(index++, states.length - 1)] }),
      'recording',
      { timeoutMs: 100, pollMs: 1, delay: vi.fn(async () => {}) },
    );
    expect(result.state).toBe('recording');
  });

  it('surfaces a native terminal error instead of timing out', async () => {
    await expect(waitForNativeCaptureState(
      () => ({ state: 'error', lastError: 'microphone unavailable' }),
      'recording',
      { timeoutMs: 100, delay: vi.fn(async () => {}) },
    )).rejects.toThrow('microphone unavailable');
  });

  it('re-reads native state after a delayed JS timer wakes', async () => {
    let reads = 0;
    const result = await waitForNativeCaptureState(
      () => ({ state: reads++ === 0 ? 'starting' : 'recording' }),
      'recording',
      {
        timeoutMs: -1,
        delay: vi.fn(async () => {}),
      },
    );
    expect(result.state).toBe('recording');
  });
});
