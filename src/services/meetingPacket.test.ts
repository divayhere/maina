/* eslint-disable import/first -- module mocks define the isolated packet pipeline. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(), getTranscriptPage: vi.fn(), listMeetingTodos: vi.fn(),
  listMeetingsEligibleForSummaryQueue: vi.fn(), listMeetingsNeedingSummary: vi.fn(),
  replaceMeetingTodos: vi.fn(), saveMeetingPacket: vi.fn(), setMeetingSummaryState: vi.fn(), updateMeeting: vi.fn(),
  updateMeetingPipelineStage: vi.fn(),
  getAppConfig: vi.fn(), maybeQueueSource: vi.fn(), maybeQueueCorrections: vi.fn(),
  getSession: vi.fn(), cloudFetch: vi.fn(), log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/data/meetings', () => ({
  getMeeting: mocks.getMeeting,
  getTranscriptPage: mocks.getTranscriptPage,
  listMeetingTodos: mocks.listMeetingTodos,
  listMeetingsEligibleForSummaryQueue: mocks.listMeetingsEligibleForSummaryQueue,
  listMeetingsNeedingSummary: mocks.listMeetingsNeedingSummary,
  replaceMeetingTodos: mocks.replaceMeetingTodos,
  saveMeetingPacket: mocks.saveMeetingPacket,
  setMeetingSummaryState: mocks.setMeetingSummaryState,
  updateMeeting: mocks.updateMeeting,
  updateMeetingPipelineStage: mocks.updateMeetingPipelineStage,
  buildTranscriptText: vi.fn(),
}));
vi.mock('@/services/config', () => ({ getAppConfig: mocks.getAppConfig }));
vi.mock('@/services/logger', () => ({ log: mocks.log }));
vi.mock('@/services/mainaKnowledgeCloud', () => ({ maybeQueueMainaKnowledgeCloudSync: mocks.maybeQueueSource }));
vi.mock('@/services/mainaKnowledgeCloudCorrections', () => ({ maybeQueueMainaKnowledgeCloudPacketCorrections: mocks.maybeQueueCorrections }));
vi.mock('@/services/mainaKnowledgeCloudCore', () => ({ mainaKnowledgeCloudSourceKey: (id: string) => `meeting:maina:${id}` }));
vi.mock('@/services/mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error { constructor(message: string, readonly status: number, readonly code?: string) { super(message); } },
  getMainaCloudSession: mocks.getSession,
  mainaCloudFetch: mocks.cloudFetch,
}));

import { buildTranscriptText } from '@/data/meetings';
import { drainMeetingPacketUntilSettled, reconcilePendingMeetingPackets, runMeetingPacketGeneration } from './meetingPacket';

describe('meetingPacket cloud broker integration', () => {
  let meeting: Record<string, unknown>;
  beforeAll(() => {
    vi.mocked(buildTranscriptText).mockResolvedValue({ text: 'Discussed launch sequencing and the next review.', blockCount: 1, wordCount: 8, source: 'blocks' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    meeting = {
      id: 'm1', title: 'Launch review', startedAt: Date.parse('2026-08-26T09:00:00Z'), language: 'en-IN',
      status: 'transcribed', summaryStatus: 'idle', cloudNotesJobId: null, cloudNotesRetryCount: 0,
      knowledgeCloudSyncStatus: 'local_only', decisions: [], openQuestions: [],
    };
    mocks.getMeeting.mockImplementation(async () => meeting);
    mocks.getTranscriptPage.mockResolvedValue({ blocks: [{ text: 'Discussed launch sequencing.' }], hasMore: false, source: 'blocks' });
    mocks.listMeetingTodos.mockResolvedValue([{ text: 'Share revised timing.' }]);
    mocks.getAppConfig.mockResolvedValue({ autoSummarize: true });
    mocks.getSession.mockResolvedValue({ accessToken: 'opaque', user: { userId: 'u1', email: 'owner@maina.local' } });
    mocks.listMeetingsEligibleForSummaryQueue.mockResolvedValue([]);
    mocks.updateMeeting.mockImplementation(async (_id: string, patch: Record<string, unknown>) => { meeting = { ...meeting, ...patch }; });
    mocks.saveMeetingPacket.mockImplementation(async () => { meeting = { ...meeting, summaryStatus: 'ready', status: 'summarized' }; });
    mocks.replaceMeetingTodos.mockResolvedValue(undefined);
    mocks.setMeetingSummaryState.mockResolvedValue(undefined);
    mocks.maybeQueueSource.mockResolvedValue(undefined);
    mocks.maybeQueueCorrections.mockResolvedValue(0);
  });

  it('uses the broker, persists a ready packet, then freezes the cloud source', async () => {
    mocks.cloudFetch.mockResolvedValue(new Response(JSON.stringify({
      job_id: 'job-1', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'ready',
      provider: 'google', model: 'managed-model', progress: { completed_sections: 1, total_sections: 1 },
      packet: { title: 'Launch review', summary: 'The team reviewed sequencing.', decisions: ['Keep the staged launch.'], todos: [{ text: 'Share revised timing.' }], open_questions: ['Who owns enablement?'] },
    })));

    await runMeetingPacketGeneration('m1');

    expect(mocks.cloudFetch).toHaveBeenCalledWith('/v1/meeting-packets', expect.objectContaining({ method: 'POST' }));
    expect(mocks.saveMeetingPacket).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'google', model: 'managed-model' }));
    expect(mocks.replaceMeetingTodos).toHaveBeenCalledWith('m1', [expect.objectContaining({ text: 'Share revised timing.' })]);
    expect(mocks.maybeQueueSource).toHaveBeenCalledWith('m1');
  });

  it('never calls a direct provider when this phone is not paired', async () => {
    mocks.getSession.mockResolvedValue(null);
    await runMeetingPacketGeneration('m1');
    expect(mocks.cloudFetch).not.toHaveBeenCalled();
    expect(mocks.setMeetingSummaryState).toHaveBeenCalledWith('m1', 'failed', expect.objectContaining({ error: expect.stringContaining('Connect Maina Cloud') }));
  });

  it('persists server section progress rather than showing generic summary progress', async () => {
    meeting = { ...meeting, cloudNotesJobId: 'job-2', summaryStatus: 'running' };
    mocks.cloudFetch.mockResolvedValue(new Response(JSON.stringify({
      job_id: 'job-2', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'processing',
      provider: 'google', model: 'managed-model', progress: { completed_sections: 2, total_sections: 5 },
    })));

    await runMeetingPacketGeneration('m1');

    expect(mocks.updateMeetingPipelineStage).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: 'm1', stage: 'summary', state: 'running', completedUnits: 2, totalUnits: 5,
    }));
  });

  it('revisits a due retryable cloud job and imports it when the server has recovered', async () => {
    meeting = {
      ...meeting,
      summaryStatus: 'retryable',
      cloudNotesJobId: 'job-recovered',
      cloudNotesRetryCount: 1,
      cloudNotesNextRetryAt: Date.now() - 1,
    };
    mocks.listMeetingsNeedingSummary.mockResolvedValue([meeting]);
    mocks.cloudFetch.mockResolvedValue(new Response(JSON.stringify({
      job_id: 'job-recovered', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'ready',
      provider: 'google', model: 'managed-model', progress: { completed_sections: 1, total_sections: 1 },
      packet: { title: 'Recovered notes', summary: 'The notes job recovered.', decisions: [], todos: [], open_questions: [] },
    })));

    await reconcilePendingMeetingPackets();
    expect(mocks.saveMeetingPacket).toHaveBeenCalled();
    expect(mocks.cloudFetch).toHaveBeenCalledWith('/v1/meeting-packets/job-recovered');
  });

  it('keeps a user-initiated iOS drain attached until the existing job settles', async () => {
    meeting = { ...meeting, cloudNotesJobId: 'job-background', summaryStatus: 'running' };
    mocks.cloudFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job_id: 'job-background', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'processing',
        provider: 'google', model: 'managed-model', progress: { completed_sections: 1, total_sections: 2 },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        job_id: 'job-background', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'ready',
        provider: 'google', model: 'managed-model', progress: { completed_sections: 2, total_sections: 2 },
        packet: { title: 'Recovered notes', summary: 'The background job completed.', decisions: [], todos: [], open_questions: [] },
      })));
    const wait = vi.fn().mockResolvedValue(undefined);

    const status = await drainMeetingPacketUntilSettled('m1', { maxPolls: 2, pollIntervalMs: 1, wait });

    expect(status).toBe('ready');
    expect(wait).toHaveBeenCalledOnce();
    expect(mocks.cloudFetch).toHaveBeenCalledTimes(2);
  });

  it('does not hot-poll retryable work excluded by the durable due query', async () => {
    mocks.listMeetingsNeedingSummary.mockResolvedValue([]);

    await reconcilePendingMeetingPackets();

    expect(mocks.cloudFetch).not.toHaveBeenCalled();
  });

  it('creates notes after the bounded recovery budget leaves at least 99% audio coverage', async () => {
    meeting = {
      ...meeting,
      status: 'transcript_partial',
      transcriptionWindowCount: 645,
      transcriptionCompletedWindows: 644,
      transcriptionFailedWindows: 1,
      transcriptionRecoveryRounds: 3,
    };
    mocks.cloudFetch.mockResolvedValue(new Response(JSON.stringify({
      job_id: 'job-partial', source_key: 'meeting:maina:m1', packet_version: 'meeting-packet-v3', status: 'ready',
      provider: 'google', model: 'managed-model', progress: { completed_sections: 1, total_sections: 1 },
      packet: { title: 'Bounded recovery', summary: 'Usable notes from high-coverage audio.', decisions: [], todos: [], open_questions: [] },
    })));

    await runMeetingPacketGeneration('m1');

    expect(mocks.saveMeetingPacket).toHaveBeenCalled();
    // Immutable source freeze remains blocked while transcript status is partial.
    expect(mocks.maybeQueueSource).toHaveBeenCalledWith('m1');
  });

  it('does not create notes from a materially incomplete transcript', async () => {
    meeting = {
      ...meeting,
      status: 'transcript_partial',
      transcriptionWindowCount: 100,
      transcriptionCompletedWindows: 90,
      transcriptionFailedWindows: 10,
      transcriptionRecoveryRounds: 3,
    };

    await runMeetingPacketGeneration('m1');

    expect(mocks.cloudFetch).not.toHaveBeenCalled();
  });

  it('serializes packet application across meetings on the shared SQLite connection', async () => {
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    mocks.getMeeting.mockImplementation(async (id: string) => ({ ...meeting, id, cloudNotesJobId: `job-${id}`, summaryStatus: 'running' }));
    mocks.cloudFetch.mockImplementation(async (path: string) => {
      activeRequests += 1;
      maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeRequests -= 1;
      const jobId = path.split('/').at(-1);
      return new Response(JSON.stringify({
        job_id: jobId, source_key: `meeting:maina:${jobId}`, packet_version: 'meeting-packet-v3', status: 'processing',
        provider: 'google', model: 'managed-model', progress: { completed_sections: 0, total_sections: 1 },
      }));
    });

    await Promise.all([
      runMeetingPacketGeneration('m1'),
      runMeetingPacketGeneration('m2'),
    ]);

    expect(maximumConcurrentRequests).toBe(1);
  });

  it('defers a transport failure durably instead of declaring notes failed', async () => {
    const TransportError = (await import('@/services/mainaCloudSession')).MainaCloudApiError;
    mocks.cloudFetch.mockRejectedValue(new TransportError('offline', 0, 'network_error'));

    await runMeetingPacketGeneration('m1');

    expect(mocks.setMeetingSummaryState).toHaveBeenCalledWith('m1', 'retryable', expect.objectContaining({
      error: expect.stringContaining('continue automatically'),
    }));
    expect(mocks.updateMeeting).toHaveBeenCalledWith('m1', expect.objectContaining({
      cloudNotesRetryCount: 1,
      cloudNotesNextRetryAt: expect.any(Number),
    }));
    expect(mocks.maybeQueueSource).not.toHaveBeenCalled();
  });

  it('keeps authentication failure terminal and preserves the local transcript', async () => {
    const CloudError = (await import('@/services/mainaCloudSession')).MainaCloudApiError;
    mocks.cloudFetch.mockRejectedValue(new CloudError('expired', 401, 'unauthorized'));

    await runMeetingPacketGeneration('m1');

    expect(mocks.setMeetingSummaryState).toHaveBeenCalledWith('m1', 'failed', expect.objectContaining({
      error: expect.stringContaining('reconnected'),
    }));
    expect(mocks.saveMeetingPacket).not.toHaveBeenCalled();
  });
});
