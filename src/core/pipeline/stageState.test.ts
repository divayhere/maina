import { describe, expect, it } from 'vitest';

import { deriveStageTransition } from './stageState';

describe('pipeline stage transitions', () => {
  it('counts a retry only when a stage enters running', () => {
    const first = deriveStageTransition(null, { state: 'running', now: 100 });
    const poll = deriveStageTransition(first, { state: 'running', now: 200 });
    const retry = deriveStageTransition({ ...first, state: 'deferred' }, { state: 'running', now: 300 });
    expect(first.attemptCount).toBe(1);
    expect(poll.attemptCount).toBe(1);
    expect(retry.attemptCount).toBe(2);
  });

  it('keeps durable progress monotonic when an older native poll arrives', () => {
    const newer = deriveStageTransition(null, {
      state: 'running', now: 100, completedUnits: 9, totalUnits: 12,
    });
    expect(deriveStageTransition(newer, {
      state: 'running', now: 120, completedUnits: 7, totalUnits: 10,
    })).toMatchObject({ completedUnits: 9, totalUnits: 12 });
  });

  it('finishes only terminal states and never clears the original attempt time', () => {
    const running = deriveStageTransition(null, { state: 'running', now: 100 });
    expect(deriveStageTransition(running, { state: 'deferred', now: 200 }))
      .toMatchObject({ startedAt: 100, finishedAt: null });
    expect(deriveStageTransition(running, { state: 'ready', now: 300 }))
      .toMatchObject({ startedAt: 100, finishedAt: 300 });
  });
});
