import { describe, expect, it } from 'vitest';

import { assessAsrResult, assessCoverage, hasPathologicalRepetition } from './quality';
import type { AsrResult, AudioWindow } from './types';

const window = (chunkId: string, startMs = 0, endMs = 15_000): AudioWindow => ({
  meetingId: 'meeting',
  recordingId: 'recording',
  chunkId,
  sourceUri: `file:///safe/${chunkId}.wav`,
  startMs,
  endMs,
  overlapBeforeMs: 1_000,
  sampleRateHz: 16_000,
  channels: 1,
});

const result = (text: string, overrides: Partial<AsrResult> = {}): AsrResult => ({
  request: {
    engineId: 'qwen3',
    engineVersion: 'proof',
    window: window('one'),
    languageHint: 'auto',
    attempt: 1,
    reason: 'primary',
  },
  outcome: 'success',
  text,
  startedAtMs: 1,
  endedAtMs: 2,
  processingMs: 1,
  diagnostics: {
    modelPackId: 'qwen3-0.6b',
    modelPackVersion: 'proof',
    truncationSuspected: false,
    repetitionSuspected: false,
    speechExpected: true,
  },
  ...overrides,
});

describe('ASR quality controller', () => {
  it('flags repeated model loops without rejecting ordinary repeated words', () => {
    expect(hasPathologicalRepetition('the the the the the the the the')).toBe(true);
    expect(hasPathologicalRepetition('I think the the issue is not with the team')).toBe(false);
  });

  it('does not treat an RMS-only speech hint as a failed transcript window', () => {
    const assessment = assessAsrResult(result(''));
    expect(assessment.suspicious).toBe(false);
    expect(assessment.reasons).toEqual([]);
  });

  it('flags an adapter-reported truncation', () => {
    const assessment = assessAsrResult(result('A partly returned transcript', {
      diagnostics: {
        modelPackId: 'qwen3-0.6b',
        modelPackVersion: 'proof',
        speechExpected: true,
        repetitionSuspected: false,
        truncationSuspected: true,
      },
    }));
    expect(assessment.reasons).toContain('truncation-suspected');
  });

  it('does not mark a meeting complete until every fixed coverage window has a terminal result', () => {
    const first = window('first', 0, 15_000);
    const second = window('second', 15_000, 30_000);
    const onlyFirst = result('hello', { request: { ...result('hello').request, window: first } });
    expect(assessCoverage([first, second], [onlyFirst])).toEqual({ complete: false, uncoveredWindows: [second] });
    const secondResult = result('world', { request: { ...onlyFirst.request, window: second } });
    expect(assessCoverage([first, second], [onlyFirst, secondResult]).complete).toBe(true);
  });
});
