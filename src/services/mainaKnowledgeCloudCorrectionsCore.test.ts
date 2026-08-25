import { describe, expect, it } from 'vitest';

import {
  buildMainaKnowledgeCloudCorrectionPackage,
  packetCorrectionSnapshots,
  sourceFieldFingerprint,
} from './mainaKnowledgeCloudCorrectionsCore';

const sourcePayload = JSON.stringify({
  schema_version: 'mkc.source.v1',
  source_key: 'meeting:maina:meeting-1',
  source_type: 'meeting',
  title: 'Original title',
  occurred_at: '2026-08-21T09:30:00.000Z',
  workspace: { key: 'maina', name: 'Maina' },
  project: { key: 'captured-meetings', name: 'Captured Meetings' },
  topics: [],
  provenance: {
    origin: 'maina-android',
    author: 'maina-app',
    captured_at: '2026-08-21T09:30:00.000Z',
    client_schema_version: 'maina.sync.v1',
  },
  content: {
    text: 'Transcript stays immutable.',
    summary: 'Original summary.',
    decisions: ['Keep the original source immutable.'],
  },
  metadata: {},
});

describe('Maina Knowledge Cloud correction core', () => {
  it('normalizes packet fields into deterministic comparison snapshots', () => {
    const snapshots = packetCorrectionSnapshots({
      title: ' Revised title ',
      summary: ' Revised summary.\r\nSecond line. ',
      decisions: [' Keep retries frozen. '],
      todos: [],
      openQuestions: [],
    });

    expect(snapshots.find((item) => item.fieldPath === 'title')?.valueFingerprint)
      .toBe('"Revised title"');
    expect(snapshots.find((item) => item.fieldPath === 'content.summary')?.valueFingerprint)
      .toBe('"Revised summary.\\nSecond line."');
    expect(snapshots.find((item) => item.fieldPath === 'content.todos')?.body)
      .toContain('none');
  });

  it('distinguishes a missing source field from an explicitly stored empty field', () => {
    expect(sourceFieldFingerprint(sourcePayload, 'content.summary')).toEqual({
      fingerprint: '"Original summary."',
      hasBaselineValue: true,
    });
    expect(sourceFieldFingerprint(sourcePayload, 'content.todos')).toEqual({
      fingerprint: '[]',
      hasBaselineValue: false,
    });
  });

  it('builds a stable immutable correction key and explicit supersession link', () => {
    const correction = buildMainaKnowledgeCloudCorrectionPackage({
      meetingId: 'meeting-1',
      sourceKey: 'meeting:maina:meeting-1',
      fieldPath: 'content.summary',
      body: 'Current regenerated summary:\nRevised summary.',
      versionNumber: 3,
      supersedesCorrectionKey: 'correction:maina:meeting-1:summary:v2',
      occurredAt: Date.parse('2026-08-22T00:00:00.000Z'),
      providerId: 'gemini',
      model: 'gemini-3.7-flash',
    });

    expect(correction.correction_key).toBe('correction:maina:meeting-1:summary:v3');
    expect(correction.supersedes_correction_key).toBe('correction:maina:meeting-1:summary:v2');
    expect(correction.version_tag).toBe('summary.v3');
    expect(correction.field_path).toBe('content.summary');
  });
});
