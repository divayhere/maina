import { requireOptionalNativeModule } from 'expo';
import type { SchedulePipelineWake } from '../../modules/maina-recorder/src';
import { Platform } from 'react-native';

type NativePipelineWakeModule = {
  addListener?(
    eventName: 'onPipelineWakeRequested',
    listener: (event: { generation: number }) => void,
  ): { remove(): void };
  schedulePipelineWake?: SchedulePipelineWake;
  completePipelineWake?(attemptToken: string, succeeded: boolean): Promise<{ completed: boolean } | boolean>;
  isPipelineWakeAttemptActive?(attemptToken: string): Promise<{ active: boolean } | boolean>;
  claimPendingPipelineWake?(): Promise<{
    attemptToken: string;
    wakeKind: 'shared';
    generation: number;
  } | null>;
};

const nativeModule = requireOptionalNativeModule<NativePipelineWakeModule>('MainaRecorder');

export async function scheduleNativePipelineWake(
  input: {
    generation: number;
    requiresNetwork: boolean;
    notBeforeAt: number;
    scheduleRevision: number;
    previousWorkId: string | null;
    previousNotBeforeAt: number | null;
    previousScheduleRevision: number | null;
  },
): Promise<{
  outcome: 'enqueued' | 'unavailable' | 'failed';
  workId?: string | null;
  errorCode?: string | null;
}> {
  if (!nativeModule?.schedulePipelineWake) {
    return { outcome: 'unavailable', errorCode: 'native_scheduler_unavailable' };
  }
  try {
    const result = await nativeModule.schedulePipelineWake(
      input.generation,
      input.requiresNetwork,
      input.notBeforeAt,
      input.scheduleRevision,
      input.previousWorkId,
      input.previousNotBeforeAt,
      input.previousScheduleRevision,
      2,
    );
    const scheduled = result.scheduled;
    return scheduled
      ? { outcome: 'enqueued', workId: result.workId ?? null }
      : {
          outcome: 'failed',
          errorCode: result.errorCode ?? 'native_enqueue_rejected',
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

export async function claimPendingNativePipelineWake(): Promise<{
  attemptToken: string;
  wakeKind: 'shared';
  generation: number;
} | null> {
  if (!nativeModule?.claimPendingPipelineWake) return null;
  return nativeModule.claimPendingPipelineWake();
}

export function subscribeNativePipelineWakeRequests(listener: () => void): () => void {
  if (Platform.OS !== 'ios' || !nativeModule?.addListener) return () => {};
  const subscription = nativeModule.addListener('onPipelineWakeRequested', () => listener());
  return () => subscription.remove();
}
