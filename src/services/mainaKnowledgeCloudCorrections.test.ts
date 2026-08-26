import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCorrection: vi.fn(),
  getLatestCorrection: vi.fn(),
  getMeeting: vi.fn(),
  insertCorrection: vi.fn(),
  listEligible: vi.fn(),
  listNeedingSync: vi.fn(),
  listMeetingCorrections: vi.fn(),
  listMeetingNeedingSync: vi.fn(),
  updateCorrection: vi.fn(),
  getSettings: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock('@/data/meetings', () => ({
  getKnowledgeCloudCorrection: mocks.getCorrection,
  getLatestKnowledgeCloudCorrection: mocks.getLatestCorrection,
  getMeeting: mocks.getMeeting,
  insertKnowledgeCloudCorrection: mocks.insertCorrection,
  listKnowledgeCloudCorrectionsEligibleForQueue: mocks.listEligible,
  listKnowledgeCloudCorrectionsNeedingSync: mocks.listNeedingSync,
  listKnowledgeCloudCorrections: mocks.listMeetingCorrections,
  listMeetingKnowledgeCloudCorrectionsNeedingSync: mocks.listMeetingNeedingSync,
  updateKnowledgeCloudCorrection: mocks.updateCorrection,
}));

vi.mock('@/services/config', () => ({
  getMainaKnowledgeCloudSettings: mocks.getSettings,
}));

vi.mock('@/services/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/services/mainaCloudSession', () => ({
  clearMainaCloudSession: mocks.clearSession,
}));

let maybeQueuePacketCorrections: typeof import('./mainaKnowledgeCloudCorrections').maybeQueueMainaKnowledgeCloudPacketCorrections;
let reconcileCorrectionsForMeeting: typeof import('./mainaKnowledgeCloudCorrections').reconcileMainaKnowledgeCloudCorrectionsForMeeting;
let runCorrectionSync: typeof import('./mainaKnowledgeCloudCorrections').runMainaKnowledgeCloudCorrectionSync;

const frozenSource = JSON.stringify({
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
  content: { text: 'Immutable transcript.', summary: 'Original summary.' },
  metadata: {},
});

describe('Maina Knowledge Cloud correction service', () => {
  beforeAll(async () => {
    const service = await import('./mainaKnowledgeCloudCorrections');
    maybeQueuePacketCorrections = service.maybeQueueMainaKnowledgeCloudPacketCorrections;
    reconcileCorrectionsForMeeting = service.reconcileMainaKnowledgeCloudCorrectionsForMeeting;
    runCorrectionSync = service.runMainaKnowledgeCloudCorrectionSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://mkc.example.test/',
      token: 'test-token',
    });
    mocks.getMeeting.mockResolvedValue({
      id: 'meeting-1',
      knowledgeCloudSourceKey: 'meeting:maina:meeting-1',
      knowledgeCloudPayloadJson: frozenSource,
      knowledgeCloudSyncStatus: 'sync_queued',
    });
    mocks.getLatestCorrection.mockResolvedValue(null);
    mocks.insertCorrection.mockResolvedValue(true);
    mocks.listMeetingNeedingSync.mockResolvedValue([]);
  });

  it('freezes only fields that changed after the source snapshot', async () => {
    const inserted = await maybeQueuePacketCorrections({
      meetingId: 'meeting-1',
      packet: {
        title: 'Original title',
        summary: 'Revised summary.',
        decisions: [],
        todos: [],
        openQuestions: [],
      },
      providerId: 'gemini',
      model: 'gemini-test',
    });

    expect(inserted).toBe(1);
    expect(mocks.insertCorrection).toHaveBeenCalledTimes(1);
    expect(mocks.insertCorrection).toHaveBeenCalledWith(expect.objectContaining({
      correctionKey: 'correction:maina:meeting-1:summary:v2',
      fieldPath: 'content.summary',
      versionNumber: 2,
    }));
    const payload = JSON.parse(mocks.insertCorrection.mock.calls[0][0].payloadJson);
    expect(payload.source_key).toBe('meeting:maina:meeting-1');
    expect(payload.field_path).toBe('content.summary');
    expect(payload).not.toHaveProperty('content');
  });

  it('does not emit a correction before the immutable source snapshot exists', async () => {
    mocks.getMeeting.mockResolvedValue({
      id: 'meeting-1',
      knowledgeCloudSourceKey: null,
      knowledgeCloudPayloadJson: null,
      knowledgeCloudSyncStatus: 'local_only',
    });

    const inserted = await maybeQueuePacketCorrections({
      meetingId: 'meeting-1',
      packet: { title: 'New', summary: 'New', decisions: [], todos: [], openQuestions: [] },
    });

    expect(inserted).toBe(0);
    expect(mocks.insertCorrection).not.toHaveBeenCalled();
  });

  it('links a regenerated field to the previous immutable correction version', async () => {
    mocks.getLatestCorrection.mockImplementation(async (_meetingId: string, fieldPath: string) =>
      fieldPath === 'content.summary'
        ? {
            correctionKey: 'correction:maina:meeting-1:summary:v2',
            versionNumber: 2,
            valueFingerprint: '"Earlier regenerated summary."',
          }
        : null);

    await maybeQueuePacketCorrections({
      meetingId: 'meeting-1',
      packet: {
        title: 'Original title',
        summary: 'Newest regenerated summary.',
        decisions: [],
        todos: [],
        openQuestions: [],
      },
    });

    expect(mocks.insertCorrection).toHaveBeenCalledWith(expect.objectContaining({
      correctionKey: 'correction:maina:meeting-1:summary:v3',
      versionNumber: 3,
      supersedesCorrectionKey: 'correction:maina:meeting-1:summary:v2',
    }));
  });

  it('posts the exact frozen correction JSON and records success', async () => {
    const payloadJson = '{"schema_version":"mkc.correction.v1","correction_key":"correction:1"}';
    const correction = {
      correctionKey: 'correction:1',
      meetingId: 'meeting-1',
      fieldPath: 'content.summary',
      versionTag: 'summary.v2',
      payloadJson,
      syncStatus: 'sync_queued',
    };
    mocks.getCorrection.mockResolvedValue(correction);
    mocks.getMeeting.mockResolvedValue({ id: 'meeting-1', knowledgeCloudSyncStatus: 'sync_succeeded' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ canonical_sha256: 'correction-sha' }),
      { status: 201 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await runCorrectionSync('correction:1');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mkc.example.test/v1/corrections',
      expect.objectContaining({ body: payloadJson }),
    );
    expect(mocks.updateCorrection).toHaveBeenLastCalledWith('correction:1', expect.objectContaining({
      syncStatus: 'sync_succeeded',
      canonicalSha256: 'correction-sha',
    }));
  });

  it('does not send a superseding correction before its predecessor succeeds', async () => {
    const previous = {
      correctionKey: 'correction:maina:meeting-1:summary:v2',
      meetingId: 'meeting-1',
      fieldPath: 'content.summary',
      versionTag: 'summary.v2',
      payloadJson: '{"correction_key":"correction:maina:meeting-1:summary:v2"}',
      syncStatus: 'sync_queued',
    };
    const next = {
      ...previous,
      correctionKey: 'correction:maina:meeting-1:summary:v3',
      versionTag: 'summary.v3',
      payloadJson: '{"correction_key":"correction:maina:meeting-1:summary:v3"}',
    };
    const state = new Map([
      [previous.correctionKey, previous],
      [next.correctionKey, next],
    ]);
    mocks.getMeeting.mockResolvedValue({
      id: 'meeting-1',
      knowledgeCloudSyncStatus: 'sync_succeeded',
    });
    mocks.listMeetingNeedingSync.mockResolvedValue([previous, next]);
    mocks.getCorrection.mockImplementation(async (key: string) => state.get(key));
    mocks.updateCorrection.mockImplementation(async (key: string, patch: Record<string, unknown>) => {
      const existing = state.get(key);
      if (existing) state.set(key, { ...existing, ...patch });
    });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetchMock);

    const attempted = await reconcileCorrectionsForMeeting('meeting-1');

    expect(attempted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.get(previous.correctionKey)?.syncStatus).toBe('sync_failed_retryable');
    expect(state.get(next.correctionKey)?.syncStatus).toBe('sync_queued');
  });
});
