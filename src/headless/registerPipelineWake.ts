import { AppRegistry, Platform } from 'react-native';

import { runDurablePipelineWake } from '@/services/backgroundPipeline';
import { isCurrentNativePostProcessingWake } from '@/services/meetingCaptureLifecycle';
import { log } from '@/services/logger';
import {
  completeNativePipelineWake,
  isNativePipelineWakeAttemptActive,
} from '@/hardware/pipelineWake';
import { requestDurablePipelineWake } from '@/services/pipelineWakeScheduler';
import {
  executeNativePipelineWakeTask,
  type NativePipelineWakeTaskData,
} from '@/headless/pipelineWakeTask';

export const MAINA_ANDROID_PIPELINE_WAKE_TASK = 'MainaPipelineWake';

if (Platform.OS === 'android') {
  AppRegistry.registerHeadlessTask(MAINA_ANDROID_PIPELINE_WAKE_TASK, () => async (
    data?: NativePipelineWakeTaskData,
  ) => {
    const outcome = await executeNativePipelineWakeTask(data, {
      completeNative: completeNativePipelineWake,
      isNativeAttemptActive: isNativePipelineWakeAttemptActive,
      isCurrentNativeResult: isCurrentNativePostProcessingWake,
      requestNativeResultWake: () => requestDurablePipelineWake({
        reason: 'native_progress',
        scheduleNative: false,
      }),
      runDurable: runDurablePipelineWake,
    });
    if (!outcome.succeeded) {
      log.warn('background-pipeline', 'Headless JS wake deferred', {
        disposition: outcome.disposition,
      });
    }
  });
}
