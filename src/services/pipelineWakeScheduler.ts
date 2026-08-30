import {
  markPipelineWakeEnqueued,
  requestPipelineWake,
  type PipelineWakeReason,
} from '@/data/pipelineWake';
import { log } from '@/services/logger';

type NativeWakeScheduler = (generation: number) => Promise<boolean>;
let nativeWakeScheduler: NativeWakeScheduler | null = null;

export function registerNativePipelineWakeScheduler(scheduler: NativeWakeScheduler): () => void {
  nativeWakeScheduler = scheduler;
  return () => {
    if (nativeWakeScheduler === scheduler) nativeWakeScheduler = null;
  };
}

export async function requestDurablePipelineWake(input: {
  reason: PipelineWakeReason;
  requestKey: string;
  connectivityRestored?: boolean;
  scheduleNative?: boolean;
}): Promise<{ generation: number; scheduled: boolean }> {
  const state = await requestPipelineWake(input);
  const scheduled = input.scheduleNative !== false && nativeWakeScheduler
    ? await nativeWakeScheduler(state.generation).catch((cause) => {
        log.warn('background-pipeline', 'native one-shot wake could not be scheduled', {
          generation: state.generation,
          causeName: cause instanceof Error ? cause.name : typeof cause,
        });
        return false;
      })
    : false;
  if (scheduled) await markPipelineWakeEnqueued(state.generation);
  return { generation: state.generation, scheduled };
}

export async function scheduleExistingPipelineWake(generation: number): Promise<boolean> {
  if (!nativeWakeScheduler) return false;
  const scheduled = await nativeWakeScheduler(generation).catch((cause) => {
    log.warn('background-pipeline', 'pending native wake could not be scheduled', {
      generation,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
    return false;
  });
  if (scheduled) await markPipelineWakeEnqueued(generation);
  return scheduled;
}
