export type NativeResumeIntentContext = {
  active: boolean;
  paused: boolean;
  saving: boolean;
  controlBusy: boolean;
  pauseCommandPending: boolean;
};

/**
 * One-slot latch for a Resume press made after the UI has rendered Paused but
 * before the native pause command has returned across the bridge. Repeated
 * presses coalesce, and terminal/invalid state consumes the intent without
 * dispatching it.
 */
export class NativeResumeIntentLatch {
  private queued = false;

  requestDuringPauseBridge(context: NativeResumeIntentContext): boolean {
    if (
      context.active &&
      context.paused &&
      !context.saving &&
      context.controlBusy &&
      context.pauseCommandPending
    ) {
      this.queued = true;
      return true;
    }
    return false;
  }

  takeAfterPauseBridge(context: NativeResumeIntentContext): boolean {
    if (!this.queued) return false;
    this.queued = false;
    return (
      context.active &&
      context.paused &&
      !context.saving &&
      !context.controlBusy &&
      !context.pauseCommandPending
    );
  }

  cancel(): void {
    this.queued = false;
  }
}
