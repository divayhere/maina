import { describe, expect, it } from 'vitest';

import { evaluateStorageBudget, formatStorageBytes, STORAGE_THRESHOLDS } from './storageBudgetCore';

describe('evaluateStorageBudget', () => {
  it('allows recording when free space exceeds the recording threshold', () => {
    const decision = evaluateStorageBudget('record', {
      availableBytes: STORAGE_THRESHOLDS.record + 10,
      totalBytes: STORAGE_THRESHOLDS.record * 4,
    });
    expect(decision.ok).toBe(true);
  });

  it('blocks export when free space is below the export threshold', () => {
    const decision = evaluateStorageBudget('export', {
      availableBytes: STORAGE_THRESHOLDS.export - 1,
      totalBytes: STORAGE_THRESHOLDS.export * 4,
    });
    expect(decision.ok).toBe(false);
    expect(decision.message).toContain('export');
  });
});

describe('formatStorageBytes', () => {
  it('formats gigabytes and megabytes compactly', () => {
    expect(formatStorageBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    expect(formatStorageBytes(128 * 1024 * 1024)).toBe('128 MB');
  });
});
