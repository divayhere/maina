import {
  createNativeDiscardCoordinator,
  type NativeDiscardProtocolDependencies,
} from '@/core/recording/nativeDiscardProtocol';
import {
  commitMeetingDiscard,
  completeMeetingDiscard,
  listMeetingDiscardTombstones,
} from '@/data/meetingDiscards';
import {
  abortNativeCapture,
  acknowledgeNativeDiscard,
  deleteNativeDiscardDirectory,
  getPendingNativeDiscard,
  prepareNativeDiscard,
} from '@/hardware/recording/foreground';

const dependencies: NativeDiscardProtocolDependencies = {
  getPending: getPendingNativeDiscard,
  prepare: prepareNativeDiscard,
  commitLogicalDelete: commitMeetingDiscard,
  listTombstones: listMeetingDiscardTombstones,
  requestAbort: async (meetingId, discardId) => abortNativeCapture(meetingId, discardId),
  acknowledge: acknowledgeNativeDiscard,
  deleteDirectory: deleteNativeDiscardDirectory,
  completeTombstone: completeMeetingDiscard,
  now: Date.now,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const coordinator = createNativeDiscardCoordinator(dependencies);

export async function discardNativeMeeting(input: {
  meetingId: string;
  discardId: string;
}): Promise<void> {
  return coordinator.execute(input);
}

export async function reconcilePendingNativeDiscards(): Promise<number> {
  return coordinator.reconcile();
}
