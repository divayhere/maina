/* eslint-disable import/first -- hoisted mocks define the native/storage boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getQuarantine: vi.fn(),
  getPendingDiscard: vi.fn(),
  getMeeting: vi.fn(),
  updateMeeting: vi.fn(),
}));

vi.mock('@/hardware/recording/foreground', () => ({
  getNativeCaptureQuarantine: mocks.getQuarantine,
  getPendingNativeDiscard: mocks.getPendingDiscard,
}));
vi.mock('@/data/meetings', () => ({
  getMeeting: mocks.getMeeting,
  updateMeeting: mocks.updateMeeting,
}));

import {
  establishNativeCaptureAutomaticWorkFence,
  readNativeCaptureAutomaticWorkFence,
  readNativeCaptureDestructiveWorkFence,
} from './nativeCaptureQuarantineFence';

describe('native capture quarantine startup fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQuarantine.mockReturnValue({ state: 'none' });
    mocks.getPendingDiscard.mockReturnValue({ state: 'none' });
  });

  it('does not enumerate meetings for clear native ownership', async () => {
    await expect(establishNativeCaptureAutomaticWorkFence()).resolves.toEqual({ protectedMeetingIds: [] });
    expect(mocks.getMeeting).not.toHaveBeenCalled();
    expect(mocks.updateMeeting).not.toHaveBeenCalled();
  });

  it('marks only the exact legacy meeting interrupted before returning its fence', async () => {
    mocks.getQuarantine.mockReturnValue({
      state: 'legacy_terminal',
      meetingId: 'meeting-legacy',
      reason: 'legacy_terminal_disposition_missing',
    });
    mocks.getMeeting.mockResolvedValue({ id: 'meeting-legacy', status: 'recording', lastError: null });
    const result = await establishNativeCaptureAutomaticWorkFence();
    expect(result).toEqual({ protectedMeetingIds: ['meeting-legacy'] });
    expect(mocks.updateMeeting).toHaveBeenCalledOnce();
    expect(mocks.updateMeeting).toHaveBeenCalledWith('meeting-legacy', {
      status: 'interrupted',
      lastError: expect.stringContaining('explicit recovery choice'),
    });
  });

  it('fails closed before storage work for malformed or orphaned ownership', async () => {
    mocks.getQuarantine.mockReturnValue({ state: 'blocked' });
    expect(() => readNativeCaptureAutomaticWorkFence()).toThrow('explicit recovery choice');
    expect(mocks.getMeeting).not.toHaveBeenCalled();

    mocks.getQuarantine.mockReturnValue({
      state: 'legacy_terminal',
      meetingId: 'missing',
      reason: 'legacy_terminal_disposition_missing',
    });
    mocks.getMeeting.mockResolvedValue(null);
    await expect(establishNativeCaptureAutomaticWorkFence()).rejects.toThrow('explicit recovery choice');
    expect(mocks.updateMeeting).not.toHaveBeenCalled();
  });

  it('combines legacy quarantine and pending discard owners for destructive work', () => {
    mocks.getQuarantine.mockReturnValue({
      state: 'legacy_terminal',
      meetingId: 'meeting-legacy',
      reason: 'legacy_terminal_disposition_missing',
    });
    mocks.getPendingDiscard.mockReturnValue({
      state: 'pending',
      meetingId: 'meeting-discard',
      discardId: 'discard-1',
      directory: 'file:///capture',
      qualificationEvidenceDigest: null,
      generation: 4,
    });
    expect(readNativeCaptureDestructiveWorkFence()).toEqual({
      protectedMeetingIds: ['meeting-legacy', 'meeting-discard'],
    });
  });

  it('fails closed when pending discard authority is unavailable', () => {
    mocks.getPendingDiscard.mockReturnValue({ state: 'blocked' });
    expect(() => readNativeCaptureDestructiveWorkFence()).toThrow('explicit recovery choice');
  });
});
