import { describe, expect, it } from 'vitest';

import { selectPurgeableStagingMeetingIds } from './stagingPurgePolicy';

describe('staging purge policy', () => {
  it('preserves an interrupted legacy-quarantine owner while purging unrelated staging rows', () => {
    expect(selectPurgeableStagingMeetingIds([
      { id: 'legacy-owner', status: 'interrupted' },
      { id: 'ordinary-recorded', status: 'recorded' },
      { id: 'active-recording', status: 'recording' },
    ], ['legacy-owner'])).toEqual(['ordinary-recorded']);
  });

  it('preserves pending-discard owners and every active recording', () => {
    expect(selectPurgeableStagingMeetingIds([
      { id: 'discard-owner', status: 'interrupted' },
      { id: 'active-recording', status: 'recording' },
    ], ['discard-owner'])).toEqual([]);
  });

  it('fails closed on malformed durable identities', () => {
    expect(() => selectPurgeableStagingMeetingIds([
      { id: 'ordinary-recorded', status: 'recorded' },
    ], ['private/path'])).toThrow('staging_purge_protected_identity_invalid');
  });
});
