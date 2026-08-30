import type { DurablePipelineWakeResult } from '@/services/backgroundPipeline';

export type NativePipelineWakeTaskData = {
  attemptToken?: string;
  wakeKind?: 'shared' | 'native_result';
  generation?: number;
  meetingId?: string;
  runId?: string;
};

export type PipelineWakeTaskDependencies = {
  completeNative(attemptToken: string, succeeded: boolean): Promise<boolean>;
  isNativeAttemptActive(attemptToken: string): Promise<boolean>;
  isCurrentNativeResult(meetingId: string, runId: string): Promise<boolean>;
  requestNativeResultWake(): Promise<{ generation: number }>;
  runDurable(input: {
    expectedGeneration: number;
    isExecutionActive(): Promise<boolean>;
  }): Promise<DurablePipelineWakeResult>;
};

export type PipelineWakeTaskOutcome = {
  succeeded: boolean;
  disposition: DurablePipelineWakeResult['disposition'] | 'invalid' | 'stale_native_result' | 'error';
};

/**
 * Owns the native completion token. Every accepted native token reaches one
 * and only one completion attempt, including validation and JS exceptions.
 */
export async function executeNativePipelineWakeTask(
  data: NativePipelineWakeTaskData | undefined,
  dependencies: PipelineWakeTaskDependencies,
): Promise<PipelineWakeTaskOutcome> {
  const attemptToken = typeof data?.attemptToken === 'string' ? data.attemptToken : '';
  let succeeded = false;
  let disposition: PipelineWakeTaskOutcome['disposition'] = 'invalid';
  try {
    if (!attemptToken) return { succeeded, disposition };
    const wakeKind = data?.wakeKind === 'native_result' ? 'native_result' : 'shared';
    let expectedGeneration: number;
    if (wakeKind === 'native_result') {
      const meetingId = typeof data?.meetingId === 'string' ? data.meetingId : '';
      const runId = typeof data?.runId === 'string' ? data.runId : '';
      if (!meetingId || !runId) return { succeeded, disposition };
      if (!await dependencies.isCurrentNativeResult(meetingId, runId)) {
        succeeded = true;
        disposition = 'stale_native_result';
        return { succeeded, disposition };
      }
      const requested = await dependencies.requestNativeResultWake();
      expectedGeneration = requested.generation;
    } else {
      expectedGeneration = Number.isSafeInteger(data?.generation) ? Number(data?.generation) : -1;
      if (expectedGeneration < 0) return { succeeded, disposition };
    }

    const result = await dependencies.runDurable({
      expectedGeneration,
      isExecutionActive: () => dependencies.isNativeAttemptActive(attemptToken),
    });
    disposition = result.disposition;
    // Busy means another lease owner is still alive; let bounded WorkManager
    // retry later. Obsolete/no-work are truthful no-ops, not manufactured work.
    succeeded = result.disposition !== 'busy';
    return { succeeded, disposition };
  } catch {
    disposition = 'error';
    return { succeeded: false, disposition };
  } finally {
    if (attemptToken) {
      await dependencies.completeNative(attemptToken, succeeded).catch(() => false);
    }
  }
}
