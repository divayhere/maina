/* eslint-disable import/first -- hoisted mocks define the filesystem boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMeeting: vi.fn(),
  listMeetings: vi.fn(),
  updateMeeting: vi.fn(),
  getConfig: vi.fn(),
  deleteNative: vi.fn(),
  inspectNative: vi.fn(),
  wavDurations: vi.fn(),
  getInfo: vi.fn(),
  deleteFile: vi.fn(),
  notify: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('expo-file-system/legacy', () => ({
  getInfoAsync: mocks.getInfo,
  deleteAsync: mocks.deleteFile,
  readDirectoryAsync: vi.fn(async () => []),
}));
vi.mock('@/data/meetings', () => ({
  getMeeting: mocks.getMeeting,
  listMeetings: mocks.listMeetings,
  updateMeeting: mocks.updateMeeting,
}));
vi.mock('@/services/config', () => ({ getAppConfig: mocks.getConfig }));
vi.mock('@/hardware/recording/foreground', () => ({
  deleteNativeCaptureDirectory: mocks.deleteNative,
  inspectNativeCaptureDirectory: mocks.inspectNative,
  getPcmWavDurationsMs: mocks.wavDurations,
}));
vi.mock('@/services/meetingPipelineSignals', () => ({ notifyMeetingPipelineChanged: mocks.notify }));
vi.mock('@/services/logger', () => ({ log: mocks.log }));

import { cleanupTerminalMeetingAudio } from './audioRetention';

const meeting = {
  id: 'meeting-1',
  status: 'transcribed',
  audioUri: 'file:///capture/meeting-1',
  durationMs: 120_000,
  audioDurationMs: 0,
  transcriptionWindowCount: 4,
  transcriptionCompletedWindows: 4,
  transcriptionFailedWindows: 0,
  audioCleanupRetryCount: 0,
  audioCleanupNextRetryAt: null,
};

describe('verified terminal audio cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMeeting.mockResolvedValue({ ...meeting });
    mocks.inspectNative.mockResolvedValue({
      finalizedUris: ['file:///capture/meeting-1/capture-00000.wav'],
      partialUris: [], recoveredCount: 0, invalidPartialCount: 0,
    });
    mocks.wavDurations.mockResolvedValue({
      'file:///capture/meeting-1/capture-00000.wav': 82_777,
    });
    mocks.deleteNative.mockResolvedValue(true);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.getInfo.mockResolvedValue({ exists: false });
    mocks.updateMeeting.mockResolvedValue(undefined);
  });

  it('measures durable WAV evidence before deletion and clears the pointer only after verification', async () => {
    const order: string[] = [];
    mocks.inspectNative.mockImplementation(async () => { order.push('inspect'); return {
      finalizedUris: ['file:///capture/meeting-1/capture-00000.wav'], partialUris: [], recoveredCount: 0, invalidPartialCount: 0,
    }; });
    mocks.deleteNative.mockImplementation(async () => { order.push('delete'); return true; });
    mocks.getInfo.mockImplementation(async () => { order.push('verify'); return { exists: false }; });
    mocks.updateMeeting.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if ('audioUri' in patch) order.push('clear-pointer');
    });

    await expect(cleanupTerminalMeetingAudio('meeting-1')).resolves.toBe(true);
    expect(order).toEqual(['inspect', 'delete', 'verify', 'clear-pointer']);
    expect(mocks.updateMeeting).toHaveBeenLastCalledWith('meeting-1', expect.objectContaining({
      audioUri: null,
      audioDurationMs: 82_777,
      durationMs: 120_000,
      audioCleanupState: 'complete',
    }));
  });

  it('keeps the database pointer and records bounded retry state when deletion is not proven', async () => {
    mocks.deleteNative.mockResolvedValue(false);
    mocks.getInfo.mockResolvedValue({ exists: true });

    await expect(cleanupTerminalMeetingAudio('meeting-1')).resolves.toBe(false);
    expect(mocks.updateMeeting).not.toHaveBeenCalledWith(
      'meeting-1', expect.objectContaining({ audioUri: null }),
    );
    expect(mocks.updateMeeting).toHaveBeenLastCalledWith('meeting-1', expect.objectContaining({
      audioCleanupState: 'retryable',
      audioCleanupRetryCount: 1,
      audioCleanupNextRetryAt: expect.any(Number),
    }));
  });

  it('coalesces duplicate cleanup signals for one meeting', async () => {
    let release!: () => void;
    mocks.deleteNative.mockImplementation(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const first = cleanupTerminalMeetingAudio('meeting-1');
    const second = cleanupTerminalMeetingAudio('meeting-1');
    expect(first).toBe(second);
    await vi.waitFor(() => expect(mocks.deleteNative).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
