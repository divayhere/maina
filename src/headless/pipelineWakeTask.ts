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
 * Only a completed drain or a truthful terminal no-op may release the native
 * owner. Busy and not-due both mean that SQLite still has live future work;
 * acknowledging either as success would let the OS discard its only wake.
 */
export function nativeWakeDispositionSucceeded(
  disposition: DurablePipelineWakeResult['disposition'],
): boolean {
  return disposition === 'completed' || disposition === 'obsolete' || disposition === 'no_work';
}

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
    // Busy and not-due retain/reschedule the native owner. Obsolete/no-work
    // are truthful terminal no-ops and completed means SQLite advanced.
    succeeded = nativeWakeDispositionSucceeded(result.disposition);
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
