import { requireOptionalNativeModule } from 'expo';

type NativePipelineWakeModule = {
  schedulePipelineWake?(generation: number): Promise<{ scheduled: boolean } | boolean>;
  completePipelineWake?(attemptToken: string, succeeded: boolean): Promise<{ completed: boolean } | boolean>;
  isPipelineWakeAttemptActive?(attemptToken: string): Promise<{ active: boolean } | boolean>;
};

const nativeModule = requireOptionalNativeModule<NativePipelineWakeModule>('MainaRecorder');

export async function scheduleNativePipelineWake(generation: number): Promise<boolean> {
  if (!nativeModule?.schedulePipelineWake) return false;
  const result = await nativeModule.schedulePipelineWake(generation);
  return typeof result === 'boolean' ? result : result.scheduled;
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
