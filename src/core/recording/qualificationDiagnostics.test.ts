import { describe, expect, it } from 'vitest';

import {
  diagnosticSuppressionSourcesActive,
  normalizeQualificationMeetingIds,
  qualificationDiagnosticSuppressed,
  referencesQualificationMeeting,
} from './qualificationDiagnostics';

describe('qualification diagnostic boundary', () => {
  const privateMeetingId = '00000000-0000-4000-8000-000000000111';
  const ids = normalizeQualificationMeetingIds([privateMeetingId, privateMeetingId, '', null]);

  it('suppresses direct and nested qualification identities', () => {
    expect(referencesQualificationMeeting({ meetingId: privateMeetingId }, ids)).toBe(true);
    expect(referencesQualificationMeeting({ result: { meetingId: privateMeetingId } }, ids)).toBe(true);
    expect(qualificationDiagnosticSuppressed({
      globallySuppressed: false,
      qualificationMeetingIds: ids,
      values: [{ meetingId: privateMeetingId }],
    })).toBe(true);
    expect(referencesQualificationMeeting(`artifact-${privateMeetingId}-audio-0`, ids)).toBe(true);
    expect(referencesQualificationMeeting(new Error(`failed at /capture/${privateMeetingId}/chunk`), ids)).toBe(true);
  });

  it('allows ordinary diagnostics after global qualification teardown', () => {
    expect(qualificationDiagnosticSuppressed({
      globallySuppressed: false,
      qualificationMeetingIds: ids,
      values: [{ meetingId: 'ordinary-meeting' }],
    })).toBe(false);
    expect(qualificationDiagnosticSuppressed({
      globallySuppressed: true,
      qualificationMeetingIds: ids,
      values: [{ meetingId: 'ordinary-meeting' }],
    })).toBe(true);
  });

  it('releases quarantine independently without clearing active qualification authority', () => {
    const legacy = normalizeQualificationMeetingIds([privateMeetingId]);
    expect(diagnosticSuppressionSourcesActive({
      qualificationActive: false,
      quarantineMeetingIds: legacy,
    })).toBe(true);
    expect(diagnosticSuppressionSourcesActive({
      qualificationActive: false,
      quarantineMeetingIds: new Set(),
    })).toBe(false);
    expect(diagnosticSuppressionSourcesActive({
      qualificationActive: true,
      quarantineMeetingIds: new Set(),
    })).toBe(true);
  });

  it('fails closed on cyclic or oversized payloads while qualification identities exist', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(referencesQualificationMeeting(cyclic, ids)).toBe(true);
    expect(referencesQualificationMeeting(new Array(257).fill('ordinary'), ids)).toBe(true);
    const unreadable = Object.defineProperty({}, 'private', {
      enumerable: true,
      get() { throw new Error('unreadable'); },
    });
    expect(referencesQualificationMeeting(unreadable, ids)).toBe(true);
  });
});
