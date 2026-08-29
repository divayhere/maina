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
import { executePipelineRecovery, type PipelineRecoveryResult } from '@/services/backgroundPipelineCore';

export const MAINA_BACKGROUND_PIPELINE_TASK = 'maina-background-pipeline-v1';
const MINIMUM_BACKGROUND_INTERVAL_MINUTES = 15;

let cycleInFlight: Promise<PipelineRecoveryResult> | null = null;

async function performPipelineRecoveryCycle(): Promise<PipelineRecoveryResult> {
  return executePipelineRecovery({
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
export function runPipelineRecoveryCycle(): Promise<PipelineRecoveryResult> {
  if (cycleInFlight) return cycleInFlight;
  const cycle = performPipelineRecoveryCycle().finally(() => {
    if (cycleInFlight === cycle) cycleInFlight = null;
  });
  cycleInFlight = cycle;
  return cycle;
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
      const result = await runPipelineRecoveryCycle();
      log.info('background-pipeline', 'OS background pipeline drain completed', {
        ...result,
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
