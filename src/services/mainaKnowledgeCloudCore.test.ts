import { describe, expect, it } from 'vitest';

import {
  buildMainaKnowledgeCloudSourcePackage,
  classifyMainaKnowledgeCloudResponse,
  describeMainaKnowledgeCloudSyncStatus,
  isMeetingEligibleForMainaKnowledgeCloudSync,
  mainaKnowledgeCloudSourceKey,
  normalizeMainaKnowledgeCloudBaseUrl,
} from './mainaKnowledgeCloudCore';

const baseMeeting = {
  id: 'meeting-1',
  title: 'Orion discovery call',
  startedAt: Date.parse('2026-08-21T09:30:00.000Z'),
  status: 'transcribed',
  summaryStatus: 'idle',
  summary: 'Orion cares more about integrations than generic AI quality.',
  decisions: ['Treat HubSpot sync as part of pilot readiness.'],
  openQuestions: ['Can SSO ship before the first pilot?'],
  language: 'en-IN',
  segmentCount: 2,
  transcribedSegments: 2,
  knowledgeCloudSyncStatus: 'local_only' as const,
  knowledgeCloudPayloadJson: null,
  knowledgeCloudError: null,
};

describe('mainaKnowledgeCloudCore', () => {
  it('normalizes the base url', () => {
    expect(normalizeMainaKnowledgeCloudBaseUrl(' https://example.com/v1/ ')).toBe('https://example.com/v1');
  });

  it('builds a stable source key from the meeting id', () => {
    expect(mainaKnowledgeCloudSourceKey('abc123')).toBe('meeting:maina:abc123');
  });

  it('waits when transcript is ready but summary generation is still running', () => {
    expect(
      isMeetingEligibleForMainaKnowledgeCloudSync({
        ...baseMeeting,
        summaryStatus: 'running',
      }),
    ).toBe(false);
  });

  it('never freezes or retries cloud payloads for incomplete ASR coverage', () => {
    expect(isMeetingEligibleForMainaKnowledgeCloudSync({
      ...baseMeeting,
      status: 'transcript_partial',
      summaryStatus: 'idle',
    })).toBe(false);
    expect(isMeetingEligibleForMainaKnowledgeCloudSync({
      ...baseMeeting,
      status: 'transcript_partial',
      summaryStatus: 'failed',
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
      knowledgeCloudPayloadJson: '{"schema_version":"mkc.source.v1"}',
    })).toBe(false);
  });

  it('allows retry states when a payload snapshot already exists', () => {
    expect(
      isMeetingEligibleForMainaKnowledgeCloudSync({
        ...baseMeeting,
        status: 'recorded',
        summaryStatus: 'failed',
        knowledgeCloudSyncStatus: 'sync_failed_retryable',
        knowledgeCloudPayloadJson: '{"schema_version":"mkc.source.v1"}',
      }),
    ).toBe(true);
  });

  it('does not auto-retry auth failures until settings change', () => {
    const authFailedMeeting = {
      ...baseMeeting,
      status: 'recorded',
      summaryStatus: 'failed',
      knowledgeCloudSyncStatus: 'sync_failed_auth' as const,
      knowledgeCloudPayloadJson: '{"schema_version":"mkc.source.v1"}',
    };

    expect(isMeetingEligibleForMainaKnowledgeCloudSync(authFailedMeeting)).toBe(false);
    expect(
      isMeetingEligibleForMainaKnowledgeCloudSync(authFailedMeeting, {
        includeAuthFailures: true,
      }),
    ).toBe(true);
  });

  it('builds a canonical source package from meeting data', () => {
    const payload = buildMainaKnowledgeCloudSourcePackage({
      meeting: baseMeeting,
      transcriptText: 'Orion wants HubSpot sync and SSO before a pilot.',
      blocks: [
        {
          blockId: 'seg-1',
          sequence: 0,
          startedAt: Date.parse('2026-08-21T09:30:05.000Z'),
          endedAt: Date.parse('2026-08-21T09:30:12.000Z'),
          language: 'en-IN',
          text: 'Orion wants HubSpot sync and SSO before a pilot.',
        },
      ],
      todos: [{ text: 'Draft HubSpot sync requirements.' }],
    });

    expect(payload.source_key).toBe('meeting:maina:meeting-1');
    expect(payload.workspace.key).toBe('maina');
    expect(payload.project.key).toBe('captured-meetings');
    expect(payload.content.blocks?.[0]?.kind).toBe('transcript');
    expect(payload.content.todos).toEqual(['Draft HubSpot sync requirements.']);
    expect(payload.provenance.origin).toBe('maina-android');
  });

  it('classifies cloud responses into sync outcomes', () => {
    expect(classifyMainaKnowledgeCloudResponse({ status: 201, body: { canonical_sha256: 'abc' } })).toEqual({
      outcome: 'success',
      canonicalSha256: 'abc',
    });
    expect(
      classifyMainaKnowledgeCloudResponse({
        status: 401,
        body: { error: { message: 'invalid token' } },
      }),
    ).toEqual({
      outcome: 'auth_failed',
      message: 'invalid token',
    });
    expect(
      classifyMainaKnowledgeCloudResponse({
        status: 503,
        body: { error: { code: 'budget_guardrail_blocked', message: 'budget paused' } },
      }),
    ).toEqual({
      outcome: 'blocked_budget',
      message: 'budget paused',
    });
  });

  it('describes sync status in user-facing language', () => {
    expect(describeMainaKnowledgeCloudSyncStatus({ status: 'sync_succeeded' }).label).toBe('Synced to cloud');
    expect(describeMainaKnowledgeCloudSyncStatus({ status: 'local_only' }).label).toBe('Only on this phone');
    expect(describeMainaKnowledgeCloudSyncStatus({ status: 'sync_failed_auth' }).label).toBe('Cloud access needs attention');
  });
});
