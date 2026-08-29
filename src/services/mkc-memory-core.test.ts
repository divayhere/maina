import { describe, expect, it } from 'vitest';

import { verifiedMemoryFixture } from './__fixtures__/mkc-memory-fixtures';
import { assessMkcMemoryIntegrity, classifyMkcMemoryFailure, makeMkcMemoryCacheKey } from './mkc-memory-core';

describe('MKC Memory core boundaries', () => {
  it('isolates cache identities by owner', () => {
    const scope = { cursor: null, query: 'quarterly' };
    expect(makeMkcMemoryCacheKey({ ownerUserId: 'owner-a', kind: 'meeting-list', scope }))
      .not.toBe(makeMkcMemoryCacheKey({ ownerUserId: 'owner-b', kind: 'meeting-list', scope }));
  });

  it('normalizes object key order in cache identities', () => {
    expect(makeMkcMemoryCacheKey({ ownerUserId: 'owner-a', kind: 'meeting-list', scope: { query: 'x', cursor: '2' } }))
      .toBe(makeMkcMemoryCacheKey({ ownerUserId: 'owner-a', kind: 'meeting-list', scope: { cursor: '2', query: 'x' } }));
  });

  it('accepts only owner-matched responses with every required checksum', () => {
    expect(assessMkcMemoryIntegrity({
      expectedOwnerUserId: verifiedMemoryFixture.ownerUserId,
      receivedOwnerUserId: verifiedMemoryFixture.ownerUserId,
      checksums: verifiedMemoryFixture.checksums,
    })).toEqual({ state: 'verified' });
  });

  it('fails closed for missing, mismatched, expired, and wrong-owner data', () => {
    expect(assessMkcMemoryIntegrity({ expectedOwnerUserId: 'a', receivedOwnerUserId: 'a', checksums: [{ field: 'result', expected: 'x', received: null }] }))
      .toEqual({ state: 'missing-checksum', field: 'result' });
    expect(assessMkcMemoryIntegrity({ expectedOwnerUserId: 'a', receivedOwnerUserId: 'a', checksums: [{ field: 'result', expected: 'x', received: 'y' }] }))
      .toEqual({ state: 'checksum-mismatch', field: 'result' });
    expect(assessMkcMemoryIntegrity({ expectedOwnerUserId: 'a', receivedOwnerUserId: 'b', checksums: [] }))
      .toEqual({ state: 'owner-mismatch' });
    expect(assessMkcMemoryIntegrity({ expectedOwnerUserId: 'a', receivedOwnerUserId: 'a', expiresAt: '2020-01-01T00:00:00.000Z', checksums: [], now: Date.now() }))
      .toEqual({ state: 'expired' });
  });

  it('sanitizes backend failures into short product states', () => {
    expect(classifyMkcMemoryFailure({ status: 0, code: 'network_timeout:https://private.example' }))
      .toEqual({ kind: 'offline', retryable: true, message: 'Showing saved information until Maina Cloud reconnects.' });
    expect(classifyMkcMemoryFailure({ status: 403, code: 'owner_mismatch' }).message)
      .not.toContain('owner_mismatch');
  });
});
