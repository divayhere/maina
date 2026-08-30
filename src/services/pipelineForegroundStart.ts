export type ForegroundPipelineStart = {
  completion: Promise<void>;
};

export type PipelineForegroundStartDependencies = {
  beginForeground(): Promise<ForegroundPipelineStart>;
  requestNativeClaim(): void;
  afterCompletion(): void | Promise<void>;
  onPersistenceError(cause: unknown): void;
  onCompletionError(cause: unknown): void;
};

export type NativeClaimGateResult = 'eligible' | 'deferred' | 'stopped';

/**
 * Keeps the native pending-claim gate recoverable for the lifetime of one
 * mounted root. Any successfully persisted foreground signal opens it once;
 * a finite SQLite contention failure therefore cannot strand later native
 * wake requests until the app remounts.
 */
export function createPipelineForegroundStarter(
  dependencies: PipelineForegroundStartDependencies,
) {
  let stopped = false;
  let nativeClaimGateOpen = false;

  const requestNativeClaim = (): NativeClaimGateResult => {
    if (stopped) return 'stopped';
    if (!nativeClaimGateOpen) return 'deferred';
    dependencies.requestNativeClaim();
    return 'eligible';
  };

  const start = async (): Promise<void> => {
    try {
      const { completion } = await dependencies.beginForeground();
      if (stopped) {
        void completion.catch(() => undefined);
        return;
      }

      if (!nativeClaimGateOpen) {
        nativeClaimGateOpen = true;
        // Opening the gate owns exactly one claim attempt. Subsequent
        // foreground observations only persist/drain their generation; native
        // events continue through requestNativeClaim and the existing in-flight
        // claim guard in the root lifecycle.
        dependencies.requestNativeClaim();
      }

      void completion
        .then(async () => {
          if (!stopped) await dependencies.afterCompletion();
        })
        .catch((cause) => {
          if (!stopped) dependencies.onCompletionError(cause);
        });
    } catch (cause) {
      if (!stopped) dependencies.onPersistenceError(cause);
    }
  };

  return {
    start,
    requestNativeClaim,
    stop() {
      stopped = true;
    },
  };
}
