import { describe, expect, it } from 'vitest';

import { canCommitLocalAsrWindow } from './localAsrClaimPolicy';

describe('local ASR late-callback ownership fence', () => {
  it('accepts only the active run and exact window claim', () => {
    const expected = { generation: 4, token: 'run-b' };
    expect(canCommitLocalAsrWindow({
      expected,
      run: { ...expected, state: 'claimed' },
      window: { ...expected, state: 'claimed' },
    })).toBe(true);
  });

  it('rejects run A after expiration and recovery run B even if A decodes late', () => {
    const runA = { generation: 3, token: 'run-a' };
    const runB = { generation: 4, token: 'run-b' };
    expect(canCommitLocalAsrWindow({
      expected: runA,
      run: { ...runB, state: 'claimed' },
      window: { ...runB, state: 'committed' },
    })).toBe(false);
  });

  it('rejects invalidated and unowned work', () => {
    const expected = { generation: 3, token: 'run-a' };
    expect(canCommitLocalAsrWindow({
      expected,
      run: { ...expected, state: 'deferred' },
      window: { ...expected, state: 'claimed' },
    })).toBe(false);
    expect(canCommitLocalAsrWindow({ expected, run: null, window: null })).toBe(false);
  });
});
