import { Platform } from 'react-native';

import { MainaRecorder, type HardwareTriggerEvent } from '../../../modules/maina-recorder/src';
import { log } from '../../services/logger';

type TriggerHandler = (event: HardwareTriggerEvent) => void | Promise<void>;

let activeHandler: TriggerHandler | null = null;
let lastDispatchAt = 0;

/** The visible recorder owns stop; the root controller owns start. */
export function registerActiveTriggerHandler(handler: TriggerHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function installHardwareTriggerListener(onIdleTrigger: TriggerHandler): () => void {
  if (Platform.OS !== 'android' || !MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onHardwareTrigger', (event) => {
    // Native already debounces, but keep a JS guard across fast remounts.
    if (event.occurredAt - lastDispatchAt < 400) return;
    lastDispatchAt = event.occurredAt;
    const target = activeHandler ? 'active-recorder' : 'start-recorder';
    log.info('trigger', 'hardware shutter pressed', {
      keyCode: event.keyCode,
      deviceId: event.deviceId,
      target,
    });
    void Promise.resolve((activeHandler ?? onIdleTrigger)(event)).catch((cause) => {
      log.error('trigger', 'hardware shutter action failed', { err: String(cause), target });
    });
  });
  return () => subscription.remove();
}
