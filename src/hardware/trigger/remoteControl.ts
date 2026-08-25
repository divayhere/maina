import type { CaptureState, HardwareTriggerEvent } from '../../../modules/maina-recorder/src';

export type RemoteCommand = HardwareTriggerEvent['command'];
export type RemoteAction = 'start' | 'pause' | 'resume' | 'stop' | 'ignore';

/** Pure state transition table shared by UI handlers and unit tests. */
export function resolveRemoteAction(state: CaptureState, command: RemoteCommand): RemoteAction {
  if (state === 'finalizing') return 'ignore';
  if (command === 'stop') return state === 'idle' ? 'ignore' : 'stop';
  if (command === 'pause') return state === 'recording' ? 'pause' : 'ignore';
  if (command === 'resume') return state === 'paused' ? 'resume' : 'ignore';
  if (command === 'start') {
    if (state === 'idle') return 'start';
    if (state === 'paused') return 'resume';
    return 'ignore';
  }
  // Toggle is the default for a one-button remote.
  if (state === 'idle') return 'start';
  if (state === 'recording') return 'pause';
  if (state === 'paused') return 'resume';
  return 'ignore';
}
