import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetMeeting,
  mockGetTranscriptPage,
  mockListMeetingTodos,
  mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  mockListMeetingsNeedingKnowledgeCloudSync,
  mockUpdateMeeting,
  mockPersistKnowledgeCloudSourceRetry,
  mockUpdateMeetingPipelineStage,
  mockGetMainaKnowledgeCloudSettings,
  mockClearMainaCloudSession,
  mockCloudRequest,
} = vi.hoisted(() => ({
  mockGetMeeting: vi.fn(),
  mockGetTranscriptPage: vi.fn(),
  mockListMeetingTodos: vi.fn(),
  mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions: vi.fn(),
  mockListMeetingsNeedingKnowledgeCloudSync: vi.fn(),
  mockUpdateMeeting: vi.fn(),
  mockPersistKnowledgeCloudSourceRetry: vi.fn(),
  mockUpdateMeetingPipelineStage: vi.fn(),
  mockGetMainaKnowledgeCloudSettings: vi.fn(),
  mockClearMainaCloudSession: vi.fn(),
  mockCloudRequest: vi.fn(),
}));

vi.mock('@/data/meetings', () => ({
  getMeeting: mockGetMeeting,
  getTranscriptPage: mockGetTranscriptPage,
  listMeetingTodos: mockListMeetingTodos,
  listMeetingsEligibleForKnowledgeCloudQueueWithOptions: mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions,
  listMeetingsNeedingKnowledgeCloudSync: mockListMeetingsNeedingKnowledgeCloudSync,
  updateMeeting: mockUpdateMeeting,
  persistKnowledgeCloudSourceRetry: mockPersistKnowledgeCloudSourceRetry,
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
  mainaCloudRequestJson: mockCloudRequest,
  shouldClearMainaCloudSession: (cause: { status?: number } | null) => cause?.status === 401,
}));
vi.mock('@/services/pipelineWakeScheduler', () => ({
  armPipelineNetworkRecovery: vi.fn().mockResolvedValue({ armed: true, generation: 1 }),
}));

let queueEligibleMainaKnowledgeCloudSyncs: typeof import('./mainaKnowledgeCloud').queueEligibleMainaKnowledgeCloudSyncs;
let runMainaKnowledgeCloudSync: typeof import('./mainaKnowledgeCloud').runMainaKnowledgeCloudSync;
let reconcilePendingMainaKnowledgeCloudSyncs: typeof import('./mainaKnowledgeCloud').reconcilePendingMainaKnowledgeCloudSyncs;

describe('mainaKnowledgeCloud service', () => {
  let meeting: Record<string, unknown>;

  beforeAll(async () => {
    const service = await import('./mainaKnowledgeCloud');
    queueEligibleMainaKnowledgeCloudSyncs = service.queueEligibleMainaKnowledgeCloudSyncs;
    runMainaKnowledgeCloudSync = service.runMainaKnowledgeCloudSync;
    reconcilePendingMainaKnowledgeCloudSyncs = service.reconcilePendingMainaKnowledgeCloudSyncs;
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
    mockPersistKnowledgeCloudSourceRetry.mockImplementation(async (input: Record<string, unknown>) => {
      meeting = {
        ...meeting,
        knowledgeCloudSyncStatus: input.syncStatus,
        knowledgeCloudError: input.visibleError,
        knowledgeCloudFailureClass: input.failureClass,
        knowledgeCloudRetryCount: input.retryCount,
        knowledgeCloudNextRetryAt: input.nextRetryAt,
      };
    });
    mockUpdateMeetingPipelineStage.mockResolvedValue(undefined);
  });

  it('marks auth failures separately so settings can recover them deliberately', async () => {
    mockCloudRequest.mockResolvedValue({
      status: 401,
      ok: false,
      data: { error: { message: 'Invalid bearer token' } },
    });

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_failed_auth');
    expect(meeting.knowledgeCloudError).toBe(
      'Reconnect Maina Cloud. Your recording and transcript are safe.',
    );
    expect(mockClearMainaCloudSession).toHaveBeenCalledOnce();
    expect(mockUpdateMeetingPipelineStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'mkc', state: 'failed',
    }));
  });

  it('keeps network failures retryable while preserving the frozen payload snapshot', async () => {
    mockCloudRequest.mockRejectedValue(Object.assign(
      new Error('Waiting for internet. Maina will continue automatically.'),
      { status: 0, code: 'network_error', failureClass: 'transport_unknown' },
    ));

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_failed_retryable');
    expect(meeting.knowledgeCloudPayloadJson).toContain('"source_key":"meeting:maina:meeting-1"');
    expect(mockUpdateMeetingPipelineStage).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'mkc', state: 'deferred',
    }));
  });

  it('terminalizes malformed successful JSON without retrying or changing source identity', async () => {
    const sourceKey = 'meeting:maina:meeting-1';
    meeting = {
      ...meeting,
      knowledgeCloudSourceKey: sourceKey,
      knowledgeCloudPayloadJson: JSON.stringify({ source_key: sourceKey }),
      knowledgeCloudSyncStatus: 'sync_queued',
    };
    mockCloudRequest.mockRejectedValue(Object.assign(
      new Error('Cloud notes need attention. Your recording and transcript are safe.'),
      { status: 200, code: 'invalid_json_response', failureClass: 'protocol' },
    ));

    await runMainaKnowledgeCloudSync('meeting-1');
    await runMainaKnowledgeCloudSync('meeting-1');

    expect(mockCloudRequest).toHaveBeenCalledTimes(1);
    expect(mockPersistKnowledgeCloudSourceRetry).not.toHaveBeenCalled();
    expect(meeting).toMatchObject({
      knowledgeCloudSyncStatus: 'sync_failed_validation',
      knowledgeCloudSourceKey: sourceKey,
      knowledgeCloudNextRetryAt: null,
      knowledgeCloudFailureClass: 'protocol',
      knowledgeCloudError: 'Cloud notes need attention. Your recording and transcript are safe.',
    });
    expect(String(meeting.knowledgeCloudError)).not.toContain('invalid_json_response');
  });

  it('does not bypass source retry due time during an automatic recovery cycle', async () => {
    meeting = {
      ...meeting,
      knowledgeCloudSyncStatus: 'sync_failed_retryable',
      knowledgeCloudNextRetryAt: Date.now() + 60_000,
      knowledgeCloudSourceKey: 'meeting:maina:meeting-1',
      knowledgeCloudPayloadJson: JSON.stringify({ source_key: 'meeting:maina:meeting-1' }),
    };

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(mockCloudRequest).not.toHaveBeenCalled();
    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_failed_retryable');
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

    mockCloudRequest.mockResolvedValue({
      status: 201,
      ok: true,
      data: { canonical_sha256: 'abc123' },
    });

    await runMainaKnowledgeCloudSync('meeting-1');

    expect(mockGetTranscriptPage).not.toHaveBeenCalled();
    expect(mockListMeetingTodos).not.toHaveBeenCalled();
    expect(mockCloudRequest).toHaveBeenCalledWith(
      '/v1/sources',
      expect.objectContaining({ body: frozenPayloadJson }),
      { acceptHttpErrors: true },
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
    mockCloudRequest.mockResolvedValue({
      status: 201,
      ok: true,
      data: { canonical_sha256: 'abc123' },
    });

    const queued = await queueEligibleMainaKnowledgeCloudSyncs({ includeAuthFailures: true });
    await Promise.resolve();

    expect(queued).toBe(1);
    expect(mockListMeetingsEligibleForKnowledgeCloudQueueWithOptions).toHaveBeenCalledWith({
      includeAuthFailures: true,
    });
  });

  it('awaits a background source drain and signals the terminal persisted state', async () => {
    const { subscribeMeetingPipelineChanges } = await import('./meetingPipelineSignals');
    const changed = vi.fn();
    const unsubscribe = subscribeMeetingPipelineChanges(changed);
    mockListMeetingsNeedingKnowledgeCloudSync
      .mockResolvedValueOnce([meeting])
      .mockResolvedValueOnce([]);
    mockCloudRequest.mockResolvedValue({
      status: 201,
      ok: true,
      data: { canonical_sha256: 'abc123' },
    });

    await reconcilePendingMainaKnowledgeCloudSyncs();
    unsubscribe();

    expect(meeting.knowledgeCloudSyncStatus).toBe('sync_succeeded');
    expect(changed).toHaveBeenCalledWith('meeting-1');
  });
});
