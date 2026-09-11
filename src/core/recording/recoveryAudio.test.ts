import { describe, expect, it } from 'vitest';

import { candidateRecoveryAudioUris } from './recoveryAudio';

describe('candidateRecoveryAudioUris', () => {
  it('retains a readable legacy segment candidate when native inspection is empty', () => {
    expect(candidateRecoveryAudioUris([], ['file:///capture/seg-0000.wav'])).toEqual([
      'file:///capture/seg-0000.wav',
    ]);
  });

  it('merges and deduplicates native and database-backed candidates', () => {
    expect(candidateRecoveryAudioUris(
      ['file:///capture/capture-0000.wav'],
      ['file:///capture/capture-0000.wav', 'file:///capture/seg-0000.wav', ''],
    )).toEqual([
      'file:///capture/capture-0000.wav',
      'file:///capture/seg-0000.wav',
    ]);
  });
});
