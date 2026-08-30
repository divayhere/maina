import { requireOptionalNativeModule } from 'expo';

type NativePipelineWakeModule = {
  schedulePipelineWake?(generation: number, requiresNetwork: boolean): Promise<{
    scheduled: boolean;
    workId?: string | null;
    errorCode?: string | null;
  } | boolean>;
  completePipelineWake?(attemptToken: string, succeeded: boolean): Promise<{ completed: boolean } | boolean>;
  isPipelineWakeAttemptActive?(attemptToken: string): Promise<{ active: boolean } | boolean>;
};

const nativeModule = requireOptionalNativeModule<NativePipelineWakeModule>('MainaRecorder');

export async function scheduleNativePipelineWake(
  generation: number,
  requiresNetwork: boolean,
): Promise<{
  outcome: 'enqueued' | 'unavailable' | 'failed';
  workId?: string | null;
  errorCode?: string | null;
}> {
  if (!nativeModule?.schedulePipelineWake) {
    return { outcome: 'unavailable', errorCode: 'native_scheduler_unavailable' };
  }
  try {
    const result = await nativeModule.schedulePipelineWake(generation, requiresNetwork);
    const scheduled = typeof result === 'boolean' ? result : result.scheduled;
    return scheduled
      ? { outcome: 'enqueued', workId: typeof result === 'boolean' ? null : result.workId ?? null }
      : {
          outcome: 'failed',
          errorCode: typeof result === 'boolean' ? 'native_enqueue_rejected' : result.errorCode ?? 'native_enqueue_rejected',
        };
  } catch (cause) {
    return {
      outcome: 'failed',
      errorCode: cause instanceof Error ? cause.name : 'native_enqueue_failed',
    };
  }
}

export async function completeNativePipelineWake(attemptToken: string, succeeded: boolean): Promise<boolean> {
  if (!nativeModule?.completePipelineWake) return false;
  const result = await nativeModule.completePipelineWake(attemptToken, succeeded);
  return typeof result === 'boolean' ? result : result.completed;
}

export async function isNativePipelineWakeAttemptActive(attemptToken: string): Promise<boolean> {
  if (!nativeModule?.isPipelineWakeAttemptActive) return false;
  const result = await nativeModule.isPipelineWakeAttemptActive(attemptToken);
  return typeof result === 'boolean' ? result : result.active;
}
