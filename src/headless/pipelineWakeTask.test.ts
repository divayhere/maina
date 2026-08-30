import { describe, expect, it, vi } from 'vitest';

import {
  executeNativePipelineWakeTask,
  type PipelineWakeTaskDependencies,
} from './pipelineWakeTask';

function dependencies(
  disposition: 'completed' | 'busy' | 'obsolete' | 'no_work' = 'completed',
): PipelineWakeTaskDependencies {
  return {
    completeNative: vi.fn(async () => true),
    isNativeAttemptActive: vi.fn(async () => true),
    isCurrentNativeResult: vi.fn(async () => true),
    requestNativeResultWake: vi.fn(async () => ({ generation: 7 })),
    runDurable: vi.fn(async () => ({ disposition, recovery: null })),
  };
}

describe('native Worker to shared pipeline ownership', () => {
  it('completes a successful shared generation exactly once', async () => {
    const deps = dependencies('completed');
    await expect(executeNativePipelineWakeTask({
      attemptToken: 'token-a',
      wakeKind: 'shared',
      generation: 3,
    }, deps)).resolves.toEqual({ succeeded: true, disposition: 'completed' });
    expect(deps.runDurable).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 3 }));
    expect(deps.completeNative).toHaveBeenCalledTimes(1);
    expect(deps.completeNative).toHaveBeenCalledWith('token-a', true);
    expect(deps.requestNativeResultWake).not.toHaveBeenCalled();
  });

  it('treats an obsolete Worker as a true no-op without requesting work', async () => {
    const deps = dependencies('obsolete');
    await expect(executeNativePipelineWakeTask({
      attemptToken: 'token-b',
      wakeKind: 'shared',
      generation: 2,
    }, deps)).resolves.toEqual({ succeeded: true, disposition: 'obsolete' });
    expect(deps.requestNativeResultWake).not.toHaveBeenCalled();
    expect(deps.completeNative).toHaveBeenCalledWith('token-b', true);
  });

  it('validates an exact native run before opening one shared generation', async () => {
    const deps = dependencies('completed');
    await executeNativePipelineWakeTask({
      attemptToken: 'token-c',
      wakeKind: 'native_result',
      meetingId: 'meeting-a',
      runId: 'run-a',
    }, deps);
    expect(deps.isCurrentNativeResult).toHaveBeenCalledWith('meeting-a', 'run-a');
    expect(deps.requestNativeResultWake).toHaveBeenCalledTimes(1);
    expect(deps.requestNativeResultWake).toHaveBeenCalledWith({ requestKey: 'native:run-a' });
    expect(deps.runDurable).toHaveBeenCalledWith(expect.objectContaining({ expectedGeneration: 7 }));
  });

  it('drops a stale native-result Worker without creating a generation', async () => {
    const deps = dependencies();
    vi.mocked(deps.isCurrentNativeResult).mockResolvedValue(false);
    await expect(executeNativePipelineWakeTask({
      attemptToken: 'token-d',
      wakeKind: 'native_result',
      meetingId: 'meeting-a',
      runId: 'old-run',
    }, deps)).resolves.toEqual({ succeeded: true, disposition: 'stale_native_result' });
    expect(deps.requestNativeResultWake).not.toHaveBeenCalled();
    expect(deps.runDurable).not.toHaveBeenCalled();
    expect(deps.completeNative).toHaveBeenCalledWith('token-d', true);
  });

  it('returns bounded-retry failure for busy ownership and JS exceptions', async () => {
    const busy = dependencies('busy');
    await executeNativePipelineWakeTask({
      attemptToken: 'token-e',
      wakeKind: 'shared',
      generation: 1,
    }, busy);
    expect(busy.completeNative).toHaveBeenCalledWith('token-e', false);

    const failed = dependencies();
    vi.mocked(failed.runDurable).mockRejectedValue(new Error('process boundary'));
    await expect(executeNativePipelineWakeTask({
      attemptToken: 'token-f',
      wakeKind: 'shared',
      generation: 1,
    }, failed)).resolves.toEqual({ succeeded: false, disposition: 'error' });
    expect(failed.completeNative).toHaveBeenCalledTimes(1);
    expect(failed.completeNative).toHaveBeenCalledWith('token-f', false);
  });

  it('rejects malformed task data but still resolves the native token once', async () => {
    const deps = dependencies();
    await expect(executeNativePipelineWakeTask({
      attemptToken: 'token-g',
      wakeKind: 'shared',
    }, deps)).resolves.toEqual({ succeeded: false, disposition: 'invalid' });
    expect(deps.runDurable).not.toHaveBeenCalled();
    expect(deps.completeNative).toHaveBeenCalledTimes(1);
    expect(deps.completeNative).toHaveBeenCalledWith('token-g', false);
  });
});
