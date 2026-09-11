import { describe, expect, it, vi } from 'vitest';

import {
  createNativeDiscardCoordinator,
  executeNativeMeetingDiscard,
  reconcileNativeMeetingDiscards,
  type NativeDiscardProtocolDependencies,
  type PendingNativeDiscard,
} from './nativeDiscardProtocol';

const tombstone: {
  meetingId: string;
  discardId: string;
  captureDirectory: string;
  qualificationEvidenceDigest: string | null;
  captureGeneration: number;
  requestedAt: number;
} = {
  meetingId: 'meeting-1',
  discardId: 'discard-1',
  captureDirectory: '/private/capture-1',
  qualificationEvidenceDigest: null,
  captureGeneration: 7,
  requestedAt: 100,
};

function harness(input: {
  native?: PendingNativeDiscard;
  tombstones?: {
    meetingId: string;
    discardId: string;
    captureDirectory: string;
    qualificationEvidenceDigest: string | null;
    captureGeneration: number;
    requestedAt: number;
  }[];
  deleteDirectory?: boolean;
  logicalDeleteFails?: boolean;
} = {}) {
  let native = input.native ?? ({ state: 'none' } as PendingNativeDiscard);
  let tombstones = [...(input.tombstones ?? [])];
  let meetingPresent = true;
  let elapsed = 100;
  const events: string[] = [];
  const committed: typeof tombstone[] = [];
  const dependencies: NativeDiscardProtocolDependencies = {
    getPending: () => native,
    prepare: (meetingId, discardId) => {
      events.push('prepare');
      native = {
        state: 'pending', meetingId, discardId, directory: tombstone.captureDirectory,
        qualificationEvidenceDigest: tombstone.qualificationEvidenceDigest,
        generation: tombstone.captureGeneration,
      };
      return native;
    },
    commitLogicalDelete: async (value) => {
      events.push('logical-delete');
      if (input.logicalDeleteFails) throw new Error('sqlite_commit_failed');
      committed.push(value);
      meetingPresent = false;
      const existing = tombstones.find((item) => item.meetingId === value.meetingId);
      if (existing && existing.discardId !== value.discardId) throw new Error('meeting_discard_identity_conflict');
      if (!existing) tombstones.push(value);
    },
    listTombstones: async () => [...tombstones],
    requestAbort: async (meetingId, discardId) => {
      events.push('abort');
      if (native.state === 'pending' && native.meetingId === meetingId && native.discardId === discardId) {
        native = { ...native, state: 'ready_for_ack' };
      }
    },
    acknowledge: async (meetingId, discardId) => {
      events.push('ack');
      if (native.state === 'ready_for_ack' && native.meetingId === meetingId && native.discardId === discardId) {
        native = { state: 'none' };
      }
    },
    deleteDirectory: async () => {
      events.push('delete-directory');
      return input.deleteDirectory ?? true;
    },
    completeTombstone: async (meetingId, discardId) => {
      events.push('complete-tombstone');
      tombstones = tombstones.filter((item) => item.meetingId !== meetingId || item.discardId !== discardId);
    },
    now: () => elapsed,
    delay: async (ms) => { elapsed += ms; },
  };
  return {
    dependencies,
    events,
    meetingPresent: () => meetingPresent,
    tombstones: () => tombstones,
    native: () => native,
    committed: () => committed,
  };
}

describe('native meeting Discard protocol', () => {
  it('durably prepares native ownership before atomically hiding the meeting', async () => {
    const state = harness();
    await executeNativeMeetingDiscard(tombstone, state.dependencies);
    expect(state.events).toEqual(['prepare', 'abort', 'logical-delete', 'ack', 'complete-tombstone']);
    expect(state.meetingPresent()).toBe(false);
    expect(state.native()).toEqual({ state: 'none' });
    expect(state.tombstones()).toEqual([]);
  });

  it('recovers a crash after native preparation but before SQLite logical deletion', async () => {
    const state = harness({
      native: {
        state: 'pending', meetingId: tombstone.meetingId, discardId: tombstone.discardId,
        directory: tombstone.captureDirectory,
        qualificationEvidenceDigest: tombstone.qualificationEvidenceDigest,
        generation: tombstone.captureGeneration,
      },
    });
    await expect(reconcileNativeMeetingDiscards(state.dependencies)).resolves.toBe(1);
    expect(state.events).toEqual(['logical-delete', 'abort', 'ack', 'complete-tombstone']);
    expect(state.meetingPresent()).toBe(false);
  });

  it('recovers after native directory deletion or SQLite deletion without resurrecting', async () => {
    for (const native of [
      {
        state: 'ready_for_ack', meetingId: tombstone.meetingId, discardId: tombstone.discardId,
        directory: tombstone.captureDirectory, qualificationEvidenceDigest: null,
        generation: tombstone.captureGeneration,
      },
      { state: 'none' },
    ] satisfies PendingNativeDiscard[]) {
      const state = harness({ native, tombstones: [tombstone] });
      await expect(reconcileNativeMeetingDiscards(state.dependencies)).resolves.toBe(1);
      expect(state.tombstones()).toEqual([]);
      expect(state.events).not.toContain('logical-delete');
    }
  });

  it('fails closed on mismatched native ownership and retains the tombstone', async () => {
    const state = harness({
      native: {
        state: 'pending', meetingId: 'meeting-2', discardId: 'discard-2', directory: '/private/capture-2',
        qualificationEvidenceDigest: null, generation: 8,
      },
      tombstones: [tombstone],
    });
    await expect(reconcileNativeMeetingDiscards(state.dependencies)).rejects.toThrow('identity_conflict');
    expect(state.tombstones()).toEqual([tombstone]);
  });

  it('retains quarantine when fallback directory cleanup is ambiguous', async () => {
    const state = harness({ native: { state: 'none' }, tombstones: [tombstone], deleteDirectory: false });
    await expect(reconcileNativeMeetingDiscards(state.dependencies)).rejects.toThrow('directory_cleanup_failed');
    expect(state.tombstones()).toEqual([tombstone]);
  });

  it('does not issue abort when native preparation is rejected', async () => {
    const state = harness();
    state.dependencies.prepare = vi.fn((): PendingNativeDiscard => ({ state: 'blocked' }));
    await expect(executeNativeMeetingDiscard(tombstone, state.dependencies)).rejects.toThrow('prepare_failed');
    expect(state.events).toEqual([]);
    expect(state.meetingPresent()).toBe(true);
  });

  it('requests native abort before a failed SQLite commit can return', async () => {
    const state = harness({ logicalDeleteFails: true });
    await expect(executeNativeMeetingDiscard(tombstone, state.dependencies)).rejects.toThrow('sqlite_commit_failed');
    expect(state.events).toEqual(['prepare', 'abort', 'logical-delete']);
    expect(state.native()).toMatchObject({ state: 'ready_for_ack', meetingId: tombstone.meetingId });
    expect(state.meetingPresent()).toBe(true);
  });

  it('rejects an abort transition that changes the prepared native generation', async () => {
    const state = harness();
    state.dependencies.requestAbort = async () => {
      state.events.push('abort');
      const current = state.native();
      if (current.state === 'pending') {
        (state.dependencies.getPending as () => PendingNativeDiscard) = () => ({
          ...current,
          state: 'ready_for_ack',
          generation: current.generation + 1,
        });
      }
    };

    await expect(executeNativeMeetingDiscard(tombstone, state.dependencies))
      .rejects.toThrow('native_discard_acknowledgement_timeout');
    expect(state.events).toEqual(['prepare', 'abort', 'logical-delete']);
    expect(state.committed()[0]?.captureGeneration).toBe(tombstone.captureGeneration);
  });

  it('serializes concurrent reconcilers into one acknowledgement workflow', async () => {
    const state = harness({
      native: {
        state: 'ready_for_ack', meetingId: tombstone.meetingId, discardId: tombstone.discardId,
        directory: tombstone.captureDirectory, qualificationEvidenceDigest: null,
        generation: tombstone.captureGeneration,
      },
      tombstones: [tombstone],
    });
    const coordinator = createNativeDiscardCoordinator(state.dependencies);
    await expect(Promise.all([coordinator.reconcile(), coordinator.reconcile()])).resolves.toEqual([1, 0]);
    expect(state.events.filter((event) => event === 'ack')).toHaveLength(1);
    expect(state.events.filter((event) => event === 'complete-tombstone')).toHaveLength(1);
    expect(state.native()).toEqual({ state: 'none' });
  });

  it('binds the tombstone to native directory, generation, and evidence rather than caller extras', async () => {
    const state = harness();
    await executeNativeMeetingDiscard({
      meetingId: tombstone.meetingId,
      discardId: tombstone.discardId,
      captureDirectory: '/caller-controlled/other-meeting',
    } as { meetingId: string; discardId: string }, state.dependencies);
    expect(state.events).toEqual(['prepare', 'abort', 'logical-delete', 'ack', 'complete-tombstone']);
    expect(state.meetingPresent()).toBe(false);
    expect(state.committed()).toEqual([tombstone]);
  });
});
