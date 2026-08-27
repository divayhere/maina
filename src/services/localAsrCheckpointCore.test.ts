import { describe, expect, it } from 'vitest';
import { localAsrWindowKey, shouldProcessLocalAsrWindow } from './localAsrCheckpointCore';

describe('iOS local ASR checkpoint identity', () => {
  it('is deterministic across process restarts', () => {
    expect(localAsrWindowKey({ chunkIndex: 2, startMs: 15_000, endMs: 30_000 }))
      .toBe('qwen3-asr-0.6b-int8@1:2:15000:30000');
  });

  it('skips only windows already committed durably', () => {
    const completed = new Set(['qwen3-asr-0.6b-int8@1:0:0:15000']);
    expect(shouldProcessLocalAsrWindow(completed, 'qwen3-asr-0.6b-int8@1:0:0:15000')).toBe(false);
    expect(shouldProcessLocalAsrWindow(completed, 'qwen3-asr-0.6b-int8@1:0:30000:45000')).toBe(true);
  });
});
