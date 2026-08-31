import { describe, expect, it } from 'vitest';

import {
  memoryPulseFixture,
  smartRecallDefinitionFixture,
  smartRecallRunFixture,
} from './__fixtures__/mkc-memory-releases-fixtures';
import {
  decodeMemoryPulse,
  decodeSmartRecallDefinition,
  decodeSmartRecallRun,
} from './mkc-memory-contract-core';

describe('MKC Memory Releases B/C contract boundary', () => {
  it('strictly decodes the pinned Pulse and saved Recall shapes', () => {
    expect(decodeMemoryPulse(memoryPulseFixture)).toEqual(memoryPulseFixture);
    expect(decodeSmartRecallDefinition(smartRecallDefinitionFixture, 'smart-recall-1')).toEqual(smartRecallDefinitionFixture);
    expect(decodeSmartRecallRun(smartRecallRunFixture, 'smart-recall-1')).toEqual(smartRecallRunFixture);
  });

  it('fails closed for missing coverage, foreign definitions, and checksum drift', () => {
    const { commitments: _ignored, ...withoutCommitments } = memoryPulseFixture;
    expect(() => decodeMemoryPulse(withoutCommitments)).toThrow(/commitments/);
    expect(() => decodeSmartRecallDefinition(smartRecallDefinitionFixture, 'foreign')).toThrow(/identity mismatch/);
    expect(() => decodeSmartRecallRun({
      ...smartRecallRunFixture,
      run: { ...smartRecallRunFixture.run, bundle_sha256: 'd'.repeat(64) },
    }, 'smart-recall-1')).toThrow(/bundle checksum mismatch/);
  });

  it('rejects unknown response fields when the deployed schema is closed', () => {
    expect(() => decodeMemoryPulse({ ...memoryPulseFixture, invented_summary: 'unsafe' })).toThrow(/unknown field/);
  });
});
