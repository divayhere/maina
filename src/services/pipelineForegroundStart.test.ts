import { describe, expect, it, vi } from 'vitest';

import { createPipelineForegroundStarter } from './pipelineForegroundStart';

describe('foreground pipeline persistence and native claim gate', () => {
  it('recovers from the first persistence failure and opens exactly one claim gate', async () => {
    const persistenceFailure = new Error('finite SQLITE_BUSY');
    const beginForeground = vi.fn()
      .mockRejectedValueOnce(persistenceFailure)
      .mockResolvedValue({ completion: Promise.resolve() });
    const requestNativeClaim = vi.fn();
    const afterCompletion = vi.fn(async () => undefined);
    const onPersistenceError = vi.fn();
    const starter = createPipelineForegroundStarter({
      beginForeground,
      requestNativeClaim,
      afterCompletion,
      onPersistenceError,
      onCompletionError: vi.fn(),
    });

    await starter.start();
    expect(onPersistenceError).toHaveBeenCalledWith(persistenceFailure);
    expect(requestNativeClaim).not.toHaveBeenCalled();
    expect(starter.requestNativeClaim()).toBe('deferred');
    expect(starter.requestNativeClaim()).toBe('deferred');

    await starter.start();
    expect(requestNativeClaim).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(afterCompletion).toHaveBeenCalledTimes(1));

    await starter.start();
    expect(requestNativeClaim).toHaveBeenCalledTimes(1);
    expect(starter.requestNativeClaim()).toBe('eligible');
    expect(requestNativeClaim).toHaveBeenCalledTimes(2);
  });

  it('cannot open or use the claim gate after the root lifecycle stops', async () => {
    const persisted = Promise.withResolvers<{ completion: Promise<void> }>();
    const completion = Promise.withResolvers<void>();
    const requestNativeClaim = vi.fn();
    const afterCompletion = vi.fn(async () => undefined);
    const onPersistenceError = vi.fn();
    const onCompletionError = vi.fn();
    const starter = createPipelineForegroundStarter({
      beginForeground: vi.fn(async () => persisted.promise),
      requestNativeClaim,
      afterCompletion,
      onPersistenceError,
      onCompletionError,
    });

    expect(starter.requestNativeClaim()).toBe('deferred');
    const start = starter.start();
    starter.stop();
    persisted.resolve({ completion: completion.promise });
    await start;
    completion.reject(new Error('late completion'));
    await Promise.resolve();

    expect(starter.requestNativeClaim()).toBe('stopped');
    expect(requestNativeClaim).not.toHaveBeenCalled();
    expect(afterCompletion).not.toHaveBeenCalled();
    expect(onPersistenceError).not.toHaveBeenCalled();
    expect(onCompletionError).not.toHaveBeenCalled();
  });
});
