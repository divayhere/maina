import { describe, expect, it, vi } from 'vitest';

import {
  createCoalescedPipelineRunner,
  executePipelineRecovery,
  type PipelineRecoveryDependencies,
} from './backgroundPipelineCore';

function dependencies(events: string[]): PipelineRecoveryDependencies {
  const step = <T>(name: string, result: T) => vi.fn(async () => { events.push(name); return result; });
  return {
    initDb: step('db', undefined),
    repairStoredRecordingReferences: step('paths', 2),
    getMeetingsWithDeletedAudio: step('deleted-audio', ['meeting']),
    markMeetingsAudioDeleted: step('mark-audio', undefined),
    reconcilePendingNativeMeetingWork: step('asr', 1),
    enforceAudioRetentionPolicy: step('retention', undefined),
    reconcileAutoSummaryEligibility: step('notes-eligible', 3),
    reconcilePendingMeetingPackets: step('notes-poll', 2),
    reconcilePendingMainaKnowledgeCloudSyncs: step('source-sync', undefined),
    reconcilePendingMainaKnowledgeCloudCorrections: step('corrections', undefined),
    flushDiagnostics: step('diagnostics', undefined),
  };
}

describe('unattended pipeline recovery', () => {
  it('runs local durability before notes and immutable cloud work', async () => {
    const events: string[] = [];
    const result = await executePipelineRecovery(dependencies(events));
    expect(events).toEqual([
      'db', 'paths', 'deleted-audio', 'mark-audio', 'asr', 'retention',
      'notes-eligible', 'notes-poll', 'source-sync', 'corrections', 'diagnostics',
    ]);
    expect(result).toEqual({ nativeMeetings: 1, pendingPackets: 2, eligiblePackets: 3, repairedReferences: 2 });
  });

  it('does not advance to notes when local ASR recovery fails', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.reconcilePendingNativeMeetingWork = vi.fn(async () => {
      events.push('asr-failed');
      throw new Error('deferred');
    });
    await expect(executePipelineRecovery(deps)).rejects.toThrow('deferred');
    expect(events).not.toContain('notes-poll');
    expect(events).not.toContain('source-sync');
  });

  it('does not fail useful recovery merely because diagnostics are unavailable', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.flushDiagnostics = vi.fn(async () => { throw new Error('offline'); });
    await expect(executePipelineRecovery(deps)).resolves.toMatchObject({ nativeMeetings: 1 });
  });

  it('coalesces concurrent signals into one effective outbox drain', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { completed: true };
    });
    const run = createCoalescedPipelineRunner(execute);
    const first = run();
    const second = run();
    expect(first).toBe(second);
    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { completed: true },
      { completed: true },
    ]);
  });

  it('checks ownership between every recovery stage', async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    let checkpoints = 0;
    deps.assertActive = vi.fn(async () => {
      checkpoints += 1;
      if (checkpoints === 6) throw new Error('lease-ended');
    });
    await expect(executePipelineRecovery(deps)).rejects.toThrow('lease-ended');
    expect(events).toContain('asr');
    expect(events).not.toContain('notes-eligible');
    expect(events).not.toContain('source-sync');
  });
});
