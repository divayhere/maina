import { describe, expect, it, vi } from 'vitest';

import { createKeyedExecutionOwner } from './keyedExecutionOwner';

describe('keyed execution ownership', () => {
  it('gives foreground and OS-worker callers the same completion handle', async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const execute = vi.fn(() => pending);
    const owner = createKeyedExecutionOwner<string, boolean>();

    const foreground = owner.run('meeting-1', execute);
    const worker = owner.run('meeting-1', execute);

    expect(foreground).toBe(worker);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(owner.has('meeting-1')).toBe(true);
    release(true);
    await expect(worker).resolves.toBe(true);
    expect(owner.has('meeting-1')).toBe(false);
  });

  it('clears failed ownership so a later durable wake can retry', async () => {
    const owner = createKeyedExecutionOwner<string, boolean>();
    await expect(owner.run('meeting-1', async () => {
      throw new Error('expired');
    })).rejects.toThrow('expired');

    await expect(owner.run('meeting-1', async () => true)).resolves.toBe(true);
  });

  it('allows different meetings to progress independently', async () => {
    const owner = createKeyedExecutionOwner<string, string>();
    const results = await Promise.all([
      owner.run('meeting-1', async () => 'one'),
      owner.run('meeting-2', async () => 'two'),
    ]);
    expect(results).toEqual(['one', 'two']);
  });
});
