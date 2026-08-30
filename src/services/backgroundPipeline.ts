import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { initDb } from '@/data/db';
import { markMeetingsAudioDeleted, repairStoredRecordingReferences } from '@/data/meetings';
import { enforceAudioRetentionPolicy } from '@/services/audioRetention';
import { log } from '@/services/logger';
import { reconcilePendingMainaKnowledgeCloudSyncs } from '@/services/mainaKnowledgeCloud';
import { reconcilePendingMainaKnowledgeCloudCorrections } from '@/services/mainaKnowledgeCloudCorrections';
import { reconcilePendingNativeMeetingWork } from '@/services/meetingCaptureLifecycle';
import { reconcileAutoSummaryEligibility, reconcilePendingMeetingPackets } from '@/services/meetingPacket';
import { flushDiagnostics, getMeetingsWithDeletedAudio } from '@/services/remoteLog';
import {
  createCoalescedPipelineRunner,
  executePipelineRecovery,
  type PipelineRecoveryResult,
} from '@/services/backgroundPipelineCore';
import {
  beginPipelineWakeAttempt,
  completePipelineWakeAttempt,
  getPipelineWakeState,
  prepareTransportRetriesForConnectivityEpoch,
  requestPipelineWake,
  renewPipelineWakeAttempt,
} from '@/data/pipelineWake';
import { scheduleExistingPipelineWake } from '@/services/pipelineWakeScheduler';

export const MAINA_BACKGROUND_PIPELINE_TASK = 'maina-background-pipeline-v1';
const MINIMUM_BACKGROUND_INTERVAL_MINUTES = 15;

async function performPipelineRecoveryCycle(assertActive?: () => Promise<void>): Promise<PipelineRecoveryResult> {
  return executePipelineRecovery({
    assertActive,
    initDb,
    repairStoredRecordingReferences,
    getMeetingsWithDeletedAudio,
    markMeetingsAudioDeleted,
    reconcilePendingNativeMeetingWork,
    enforceAudioRetentionPolicy,
    reconcileAutoSummaryEligibility,
    reconcilePendingMeetingPackets,
    reconcilePendingMainaKnowledgeCloudSyncs,
    reconcilePendingMainaKnowledgeCloudCorrections,
    flushDiagnostics,
  });
}

/** One idempotent outbox drain shared by foreground, reconnect and OS wakeups. */
export const runPipelineRecoveryCycle = createCoalescedPipelineRunner(performPipelineRecoveryCycle);

/**
 * Claims the single durable wake row before touching any outbox. Native OS
 * workers and foreground listeners both call this function, so concurrent
 * connectivity/AppState signals can produce only one effective drain.
 */
export type DurablePipelineWakeResult = {
  disposition: 'completed' | 'busy' | 'obsolete' | 'no_work';
  recovery: PipelineRecoveryResult | null;
};

export async function runDurablePipelineWake(input: {
  expectedGeneration: number;
  isExecutionActive?: () => Promise<boolean>;
}): Promise<DurablePipelineWakeResult> {
  const claim = await beginPipelineWakeAttempt(input.expectedGeneration);
  if (claim.status === 'busy' || claim.status === 'obsolete' || claim.status === 'no_work') {
    return { disposition: claim.status, recovery: null };
  }
  let stopped = false;
  const assertActive = async () => {
    if (stopped) throw new Error('Pipeline wake ownership ended.');
    if (input.isExecutionActive && !await input.isExecutionActive()) {
      stopped = true;
      throw new Error('Native pipeline wake execution ended.');
    }
    if (!await renewPipelineWakeAttempt(claim.token)) {
      stopped = true;
      throw new Error('Pipeline wake lease ownership was lost.');
    }
  };
  const leaseHeartbeat = setInterval(() => {
    void assertActive().catch(() => {
      stopped = true;
    });
  }, 15_000);
  try {
    await assertActive();
    await prepareTransportRetriesForConnectivityEpoch(claim.connectivityEpoch);
    const result = await runPipelineRecoveryCycle(assertActive);
    await assertActive();
    if (!await completePipelineWakeAttempt({ token: claim.token, succeeded: true })) {
      throw new Error('Pipeline wake completion lost lease ownership.');
    }
    const pending = await getPipelineWakeState();
    if (pending.enqueueRequired) {
      await scheduleExistingPipelineWake(pending.generation);
    }
    return { disposition: 'completed', recovery: result };
  } catch (cause) {
    await completePipelineWakeAttempt({
      token: claim.token,
      succeeded: false,
      errorCode: cause instanceof Error ? cause.name : 'unknown',
    }).catch(() => false);
    throw cause;
  } finally {
    stopped = true;
    clearInterval(leaseHeartbeat);
  }
}

if (!TaskManager.isTaskDefined(MAINA_BACKGROUND_PIPELINE_TASK)) {
  TaskManager.defineTask(MAINA_BACKGROUND_PIPELINE_TASK, async ({ error, executionInfo }) => {
    if (error) {
      log.warn('background-pipeline', 'OS background task arrived with an error', {
        code: error.code,
        eventId: executionInfo.eventId,
      });
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
    try {
      const state = await requestPipelineWake({
        reason: 'os_worker',
        requestKey: `expo:${executionInfo.eventId}`,
      });
      const result = await runDurablePipelineWake({ expectedGeneration: state.generation });
      log.info('background-pipeline', 'OS background pipeline drain completed', {
        ...(result.recovery ?? {}),
        disposition: result.disposition,
        eventId: executionInfo.eventId,
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (cause) {
      log.warn('background-pipeline', 'OS background pipeline drain deferred', {
        err: String(cause),
        eventId: executionInfo.eventId,
      });
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerBackgroundPipelineRecovery(): Promise<boolean> {
  if (Platform.OS === 'web' || !await TaskManager.isAvailableAsync()) return false;
  const status = await BackgroundTask.getStatusAsync();
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  if (!await TaskManager.isTaskRegisteredAsync(MAINA_BACKGROUND_PIPELINE_TASK)) {
    await BackgroundTask.registerTaskAsync(MAINA_BACKGROUND_PIPELINE_TASK, {
      minimumInterval: MINIMUM_BACKGROUND_INTERVAL_MINUTES,
    });
  }
  return true;
}

export async function triggerBackgroundPipelineForTesting(): Promise<boolean> {
  if (!__DEV__) return false;
  return BackgroundTask.triggerTaskWorkerForTestingAsync();
}
