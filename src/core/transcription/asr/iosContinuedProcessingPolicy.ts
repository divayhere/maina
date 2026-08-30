import { createKeyedExecutionOwner } from '@/core/pipeline/keyedExecutionOwner';

export type IOSContinuedProcessingHandleState = {
  requestId: string;
  meetingId: string;
  asrGeneration: number | null;
  deferralRequested: boolean;
};

export type IOSContinuedProcessingDeferralIdentity = {
  requestId: string;
  meetingId: string;
  asrGeneration: number;
};

export type IOSContinuedProcessingDeferralResult =
  | 'identity_mismatch'
  | 'fenced'
  | 'stale_or_complete'
  | 'fence_failed';

type IOSContinuedProcessingDeferralOperations = {
  fenceGeneration(event: IOSContinuedProcessingDeferralIdentity): Promise<boolean>;
  markStageDeferred(event: IOSContinuedProcessingDeferralIdentity): Promise<void>;
  acknowledge(event: IOSContinuedProcessingDeferralIdentity): void;
  onFenceError?(cause: unknown): void;
  onStageError?(cause: unknown): void;
};

export function acceptIOSContinuedProcessingDeferral(
  handle: IOSContinuedProcessingHandleState | undefined,
  event: IOSContinuedProcessingDeferralIdentity,
): 'unowned' | 'accepted' | 'duplicate' | 'identity_mismatch' {
  if (!handle) return 'unowned';
  if (handle.requestId !== event.requestId || handle.meetingId !== event.meetingId) {
    return 'identity_mismatch';
  }
  if (handle.asrGeneration != null && handle.asrGeneration !== event.asrGeneration) {
    return 'identity_mismatch';
  }
  if (handle.deferralRequested) return 'duplicate';
  handle.deferralRequested = true;
  return 'accepted';
}

/**
 * Owns the complete native-expiration handshake for one submitted request.
 * Concurrent duplicate callbacks join the same promise, so none can
 * acknowledge before the exact SQLite generation has been checked. A false
 * compare-and-set means the run is already complete/deferred/stale and must
 * never regress its pipeline stage. A thrown compare-and-set leaves native's
 * one-second fail-safe as the only completion owner.
 */
export function createIOSContinuedProcessingDeferralHandler(
  operations: IOSContinuedProcessingDeferralOperations,
) {
  const owner = createKeyedExecutionOwner<string, IOSContinuedProcessingDeferralResult>();

  return (
    handle: IOSContinuedProcessingHandleState | undefined,
    event: IOSContinuedProcessingDeferralIdentity,
  ): Promise<IOSContinuedProcessingDeferralResult> => {
    const disposition = acceptIOSContinuedProcessingDeferral(handle, event);
    if (disposition === 'identity_mismatch') return Promise.resolve('identity_mismatch');

    return owner.run(event.requestId, async () => {
      let fenced: boolean;
      try {
        fenced = await operations.fenceGeneration(event);
      } catch (cause) {
        operations.onFenceError?.(cause);
        return 'fence_failed';
      }

      if (fenced) {
        try {
          await operations.markStageDeferred(event);
        } catch (cause) {
          // The durable generation fence already succeeded. Native may be
          // acknowledged even if the independently rendered stage needs later
          // reconciliation; never undo or duplicate the durable CAS.
          operations.onStageError?.(cause);
        }
      }

      operations.acknowledge(event);
      return fenced ? 'fenced' : 'stale_or_complete';
    });
  };
}
