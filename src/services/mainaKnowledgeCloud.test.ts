import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetMeeting,
  mockGetTranscriptPage,
  mockListMeetingTodos,
  mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  mockListMeetingsNeedingKnowledgeCloudSync,
  mockUpdateMeeting,
  mockUpdateMeetingPipelineStage,
  mockGetMainaKnowledgeCloudSettings,
  mockClearMainaCloudSession,
} = vi.hoisted(() => ({
  mockGetMeeting: vi.fn(),
  mockGetTranscriptPage: vi.fn(),
  mockListMeetingTodos: vi.fn(),
  mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions: vi.fn(),
  mockListMeetingsNeedingKnowledgeCloudSync: vi.fn(),
  mockUpdateMeeting: vi.fn(),
  mockUpdateMeetingPipelineStage: vi.fn(),
  mockGetMainaKnowledgeCloudSettings: vi.fn(),
  mockClearMainaCloudSession: vi.fn(),
}));

vi.mock('@/data/meetings', () => ({
  getMeeting: mockGetMeeting,
  getTranscriptPage: mockGetTranscriptPage,
  listMeetingTodos: mockListMeetingTodos,
  listMeetingsEligibleForKnowledgeCloudQueueWithOptions: mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  listMeetingsNeedingKnowledgeCloudSync: mockListMeetingsNeedingKnowledgeCloudSync,
  updateMeeting: mockUpdateMeeting,
  updateMeetingPipelineStage: mockUpdateMeetingPipelineStage,
}));

vi.mock('@/services/config', () => ({
  getMainaKnowledgeCloudSettings: mockGetMainaKnowledgeCloudSettings,
}));

vi.mock('@/services/logger', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/services/mainaCloudSession', () => ({
  clearMainaCloudSession: mockClearMainaCloudSession,
}));

let queueEligibleMainaKnowledgeCloudSyncs: typeof import('./mainaKnowledgeCloud').queueEligibleMainaKnowledgeCloudSyncs;
let runMainaKnowledgeCloudSync: typeof import('./mainaKnowledgeCloud').runMainaKnowledgeCloudSync;

describe('mainaKnowledgeCloud service', () => {
  let meeting: Record<string, unknown>;

  beforeAll(async () => {
    const service = await import('./mainaKnowledgeCloud');
    queueEligibleMainaKnowledgeCloudSyncs = service.queueEligibleMainaKnowledgeCloudSyncs;
    runMainaKnowledgeCloudSync = service.runMainaKnowledgeCloudSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    meeting = {
      id: 'meeting-1',
      title: 'Cloud sync test',
      startedAt: Date.parse('2026-08-21T15:22:25.097Z'),
      status: 'transcribed',
      summaryStatus: 'idle',
      transcript: null,
      summary: 'A short summary.',
      decisions: ['Keep the frozen payload stable.'],
      openQuestions: ['Does auth failure pause retries?'],
      language: 'en-IN',
      segmentCount: 1,
      transcribedSegments: 1,
      knowledgeCloudSyncStatus: 'local_only',
      knowledgeCloudPayloadJson: null,
      knowledgeCloudSourceKey: null,
      knowledgeCloudError: null,
    };

    mockGetMainaKnowledgeCloudSettings.mockResolvedValue({
      enabled: true,
      baseUrl: 'https://mkc-backend.maina-knowledge-cloud.workers.dev',
      token: 'mkc_test_token',
    });
    mockGetMeeting.mockImplementation(async () => meeting);
    mockGetTranscriptPage.mockResolvedValue({
      blocks: [
        {
          blockId: 'seg-1',
          sequence: 0,
          startedAt: Date.parse('2026-08-21T15:22:30.000Z'),
          endedAt: Date.parse('2026-08-21T15:22:40.000Z'),
          language: 'en-IN',
          text: 'This is the frozen transcript text.',
        },
      ],
      hasMore: false,
      source: 'blocks',
    });
    mockListMeetingTodos.mockResolvedValue([{ text: 'Review cloud sync result.' }]);
    mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions.mockResolvedValue([]);
    mockListMeetingsNeedingKnowledgeCloudSync.mockResolvedValue([]);
    mockUpdateMeeting.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      meeting = {
        ...meeting,
        ...patch,
      };
    });
    mockUpdateMeetingPipelineStage.mockResolvedValue(undefined);
  });

  it('marks auth failures separately so settings can recover them deliberately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid bearer token' } }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      ),
    );

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_failed_auth');
    expect(meeting.knowledgeCloudError).toBe('Invalid bearer token');
    expect(mockClearMainaCloudSession).toHaveBeenCalledOnce();
    expect(mockUpdateMeetingPipelineStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'mkc', state: 'failed',
    }));
  });

  it('keeps network failures retryable while preserving the frozen payload snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Network request failed')),
    );

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_failed_retryable');
    expect(meeting.knowledgeCloudPayloadJson).toContain('"source_key":"meeting:maina:meeting-1"');
    expect(mockUpdateMeetingPipelineStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'mkc', state: 'deferred',
    }));
  });

  it('reuses a stored frozen payload on retry instead of rebuilding from newer local state', async () => {
    const frozenPayloadJson = JSON.stringify({
      schema_version: 'mkc.source.v1',
      source_key: 'meeting:maina:meeting-1',
      source_type: 'meeting',
      title: 'Frozen title',
      occurred_at: '2026-08-21T15:22:25.097Z',
      workspace: { key: 'maina', name: 'Maina' },
      project: { key: 'captured-meetings', name: 'Captured Meetings' },
      topics: [],
      provenance: {
        origin: 'maina-android',
        author: 'maina-app',
        captured_at: '2026-08-21T15:22:25.097Z',
        client_schema_version: 'maina.sync.v1',
      },
      content: {
        text: 'Frozen transcript text.',
      },
      metadata: {
        local_status: 'transcribed',
      },
    });

    meeting = {
      ...meeting,
      status: 'recorded',
      summaryStatus: 'failed',
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
      knowledgeCloudPayloadJson: frozenPayloadJson,
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ canonical_sha256: 'abc123' }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(mockGetTranscriptPage).not.toHaveBeenCalled();
    expect(mockListMeetingTodos).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mkc-backend.maina-knowledge-cloud.workers.dev/v1/sources',
      expect.objectContaining({
        body: frozenPayloadJson,
      }),
    );
    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_succeeded');
    expect(mockUpdateMeetingPipelineStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'mkc', state: 'ready', completedUnits: 1, totalUnits: 1,
    }));
  });

  it('can intentionally requeue auth-blocked meetings after settings change', async () => {
    meeting = {
      ...meeting,
      status: 'recorded',
      summaryStatus: 'failed',
      knowledgeCloudSyncStatus: 'sync_failed_auth',
      knowledgeCloudPayloadJson: JSON.stringify({
        schema_version: 'mkc.source.v1',
        source_key: 'meeting:maina:meeting-1',
        source_type: 'meeting',
        title: 'Frozen title',
        occurred_at: '2026-08-21T15:22:25.097Z',
        workspace: { key: 'maina', name: 'Maina' },
        project: { key: 'captured-meetings', name: 'Captured Meetings' },
        topics: [],
        provenance: {
          origin: 'maina-android',
          author: 'maina-app',
          captured_at: '2026-08-21T15:22:25.097Z',
          client_schema_version: 'maina.sync.v1',
        },
        content: { text: 'Frozen transcript text.' },
        metadata: { local_status: 'transcribed' },
      }),
    };
    mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions.mockResolvedValue([meeting]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ canonical_sha256: 'abc123' }), {
          status: 201,
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      ),
    );

    const queued = await queueEligibleMainaKnowledgeCloudSyncs({ includeAuthFailures: true });
    await Promise.resolve();

    expect(queued).toBe(1);
    expect(mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions).toHaveBeenCalledWith({
      includeAuthFailures: true,
    });
  });
});
