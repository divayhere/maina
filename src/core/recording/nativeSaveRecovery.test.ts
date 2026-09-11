import { describe, expect, it } from 'vitest';

import {
  classifyNativeSaveStatus,
  NativeTerminalIntentLatch,
  nativeSaveEntryAction,
  nativeSavePresentationSurface,
  nativeTerminalIntentAdmission,
  recoveryModeForClassification,
  waitForNativeTerminalRecovery,
} from './nativeSaveRecovery';

describe('native save recovery entry', () => {
  it('makes terminal busy the sole highest-priority render authority', () => {
    expect(nativeSavePresentationSurface({ busy: true, error: null })).toBe('busy');
    expect(nativeSavePresentationSurface({ busy: true, error: 'stale error' })).toBe('busy');
    expect(nativeSavePresentationSurface({ busy: false, error: 'bounded recovery' })).toBe('error');
    expect(nativeSavePresentationSurface({ busy: false, error: null })).toBe('recording');
  });

  it('admits exactly one new terminal intent and only its own continuation', () => {
    expect(nativeTerminalIntentAdmission({ current: null, requested: 'save', continuation: false })).toBe(true);
    expect(nativeTerminalIntentAdmission({ current: null, requested: 'discard', continuation: false })).toBe(true);
    expect(nativeTerminalIntentAdmission({ current: 'discard', requested: 'save', continuation: false })).toBe(false);
    expect(nativeTerminalIntentAdmission({ current: 'save', requested: 'discard', continuation: false })).toBe(false);
    expect(nativeTerminalIntentAdmission({ current: 'save', requested: 'save', continuation: true })).toBe(true);
    expect(nativeTerminalIntentAdmission({ current: 'discard', requested: 'discard', continuation: true })).toBe(true);
    expect(nativeTerminalIntentAdmission({ current: 'discard', requested: 'save', continuation: true })).toBe(false);
  });

  it('blocks Save and hardware Stop while a deferred Discard owns terminalization', async () => {
    const latch = new NativeTerminalIntentLatch();
    let releaseAbort!: () => void;
    const abortCompletion = new Promise<void>((resolve) => { releaseAbort = resolve; });
    let stopCalls = 0;
    let saveTailCalls = 0;

    const discard = async () => {
      if (!latch.tryBegin('discard')) return;
      await abortCompletion;
    };
    const save = async () => {
      if (!latch.tryBegin('save')) return;
      stopCalls += 1;
      saveTailCalls += 1;
    };

    const discardWork = discard();
    await save();
    await save(); // models the non-visual hardware Stop callback
    releaseAbort();
    await discardWork;

    expect(latch.current()).toBe('discard');
    expect(stopCalls).toBe(0);
    expect(saveTailCalls).toBe(0);
  });

  it('starts one terminal stop only from the ordinary unsaved state', () => {
    expect(nativeSaveEntryAction({ saving: false, recoveryMode: null, statusCheckBusy: false }))
      .toBe('begin_stop');
  });

  it('retains the exact bounded recovery action after terminal completion becomes ambiguous', () => {
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'check_terminal_status', statusCheckBusy: false }))
      .toBe('check_terminal_status');
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'retry_terminal_once', statusCheckBusy: false }))
      .toBe('retry_terminal_once');
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'retry_stop_submission_once', statusCheckBusy: false }))
      .toBe('retry_stop_submission_once');
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'resume_checkpoint', statusCheckBusy: false }))
      .toBe('resume_checkpoint');
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'restart_required', statusCheckBusy: false }))
      .toBe('restart_required');
  });

  it('coalesces repeated status checks and ordinary repeated saves', () => {
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: 'check_terminal_status', statusCheckBusy: true }))
      .toBe('ignore');
    expect(nativeSaveEntryAction({ saving: true, recoveryMode: null, statusCheckBusy: false }))
      .toBe('ignore');
  });

  it('requires exact Android meeting-bound terminal success', () => {
    expect(classifyNativeSaveStatus({
      status: {
        state: 'idle', meetingId: 'meeting-1', terminalPublicationState: 'succeeded', terminalReasonCode: 'stop_succeeded',
      },
      expectedMeetingId: 'meeting-1', platform: 'android', retryAvailable: true,
    })).toBe('complete');
    expect(classifyNativeSaveStatus({
      status: { state: 'idle', meetingId: 'meeting-2' },
      expectedMeetingId: 'meeting-1', platform: 'android', retryAvailable: true,
    })).toBe('restart_required');
    expect(classifyNativeSaveStatus({
      status: { state: 'idle', meetingId: 'meeting-1' },
      expectedMeetingId: 'meeting-1', platform: 'android', retryAvailable: true,
    })).toBe('restart_required');
  });

  it('classifies queued, one-shot retryable, and consumed recovery states', () => {
    const base = {
      expectedMeetingId: 'meeting-1',
      platform: 'android' as const,
    };
    expect(classifyNativeSaveStatus({
      ...base,
      retryAvailable: true,
      status: {
        state: 'finalizing', meetingId: 'meeting-1', terminalPublicationState: 'running', terminalReasonCode: 'stop_running',
      },
    })).toBe('pending');
    const failed = {
      state: 'error' as const,
      meetingId: 'meeting-1',
      terminalPublicationState: 'recovery_required' as const,
      terminalReasonCode: 'stop_timeout_or_error' as const,
    };
    expect(classifyNativeSaveStatus({ ...base, retryAvailable: true, status: failed })).toBe('retryable_once');
    expect(classifyNativeSaveStatus({ ...base, retryAvailable: false, status: failed })).toBe('restart_required');
    expect(classifyNativeSaveStatus({
      ...base,
      retryAvailable: true,
      submissionRetryAvailable: true,
      status: {
        state: 'recording', meetingId: 'meeting-1', terminalPublicationState: 'none', terminalReasonCode: 'no_terminal_operation',
      },
    })).toBe('submission_retryable_once');
    expect(classifyNativeSaveStatus({
      ...base,
      retryAvailable: true,
      submissionRetryAvailable: false,
      status: {
        state: 'recording', meetingId: 'meeting-1', terminalPublicationState: 'none', terminalReasonCode: 'no_terminal_operation',
      },
    })).toBe('restart_required');
  });

  it('rejects contradictory terminal publication and reason pairs', () => {
    const base = {
      state: 'finalizing' as const,
      meetingId: 'meeting-1',
    };
    for (const status of [
      { ...base, terminalPublicationState: 'queued' as const, terminalReasonCode: 'stop_running' as const },
      { ...base, terminalPublicationState: 'running' as const, terminalReasonCode: 'stop_queued' as const },
    ]) {
      expect(classifyNativeSaveStatus({
        status, expectedMeetingId: 'meeting-1', platform: 'android', retryAvailable: true,
      })).toBe('restart_required');
    }
  });

  it('accepts the real iOS idle shape only with an exact clean terminal audio receipt', () => {
    const clean = {
      state: 'idle' as const,
      meetingId: null,
      terminalMeetingId: 'meeting-1',
      terminalReceiptSchemaVersion: 'maina.ios-native-stop.v1' as const,
      terminalGeneration: 7,
      terminalDisposition: 'save' as const,
      terminalPublicationState: 'succeeded' as const,
      terminalReasonCode: 'stop_succeeded' as const,
      terminalSegmentCount: 2,
      terminalAudioBytes: 32_768,
      lastError: null,
    };
    expect(classifyNativeSaveStatus({
      status: clean,
      expectedMeetingId: 'meeting-1', platform: 'ios', retryAvailable: false,
    })).toBe('complete');
    for (const status of [
      { ...clean, meetingId: 'meeting-1' },
      { ...clean, terminalMeetingId: null },
      { ...clean, terminalMeetingId: 'meeting-2' },
      { ...clean, terminalReceiptSchemaVersion: null },
      { ...clean, terminalGeneration: 0 },
      { ...clean, terminalDisposition: 'discard' as const },
      { ...clean, terminalPublicationState: 'recovery_required' as const },
      { ...clean, terminalReasonCode: 'stop_timeout_or_error' as const },
      { ...clean, terminalSegmentCount: 0 },
      { ...clean, terminalAudioBytes: 0 },
      { ...clean, lastError: 'chunk finalization failed' },
      { ...clean, state: 'recording' as const },
    ]) {
      expect(classifyNativeSaveStatus({
        status, expectedMeetingId: 'meeting-1', platform: 'ios', retryAvailable: false,
      })).toBe('restart_required');
    }
    expect(classifyNativeSaveStatus({
      status: null, expectedMeetingId: 'meeting-1', platform: 'ios', retryAvailable: false,
    })).toBe('restart_required');
  });

  it('maps every nonterminal classification to a closed UI mode', () => {
    expect(recoveryModeForClassification('pending')).toBe('check_terminal_status');
    expect(recoveryModeForClassification('retryable_once')).toBe('retry_terminal_once');
    expect(recoveryModeForClassification('submission_retryable_once')).toBe('retry_stop_submission_once');
    expect(recoveryModeForClassification('restart_required')).toBe('restart_required');
  });

  it('waits through stale pre-delivery errors for one newer terminal operation', async () => {
    const staleRecovery = {
        state: 'error' as const, meetingId: 'meeting-1', terminalOperationId: 7,
        terminalPublicationState: 'recovery_required' as const,
        terminalReasonCode: 'stop_timeout_or_error' as const,
    };
    const statuses = [
      ...Array.from({ length: 12 }, () => staleRecovery),
      {
        state: 'finalizing' as const, meetingId: 'meeting-1', terminalOperationId: 9,
        terminalPublicationState: 'running' as const,
        terminalReasonCode: 'stop_running' as const,
      },
      {
        state: 'idle' as const, meetingId: 'meeting-1', terminalOperationId: 9,
        terminalPublicationState: 'succeeded' as const,
        terminalReasonCode: 'stop_succeeded' as const,
      },
    ];
    let elapsed = 0;
    const result = await waitForNativeTerminalRecovery(
      () => statuses.shift() ?? null,
      { expectedMeetingId: 'meeting-1', priorOperationId: 7 },
      { now: () => elapsed, delay: async (ms) => { elapsed += ms; } },
    );
    expect(result?.state).toBe('idle');
    expect(result?.terminalOperationId).toBe(9);
    expect(statuses).toHaveLength(0);
  });

  it('waits through stale recovery beyond one second and closes only at timeout or identity drift', async () => {
    let elapsed = 0;
    const stale = {
      state: 'error' as const, meetingId: 'meeting-1', terminalOperationId: 7,
      terminalPublicationState: 'recovery_required' as const,
      terminalReasonCode: 'stop_timeout_or_error' as const,
    };
    const result = await waitForNativeTerminalRecovery(
      () => stale,
      { expectedMeetingId: 'meeting-1', priorOperationId: 7 },
      { timeoutMs: 1_200, pollMs: 100, now: () => elapsed, delay: async (ms) => { elapsed += ms; } },
    );
    expect(result).toEqual(stale);
    expect(elapsed).toBe(1_300);

    expect(await waitForNativeTerminalRecovery(
      () => ({ ...stale, meetingId: 'meeting-2' }),
      { expectedMeetingId: 'meeting-1', priorOperationId: 7 },
      { now: () => 0, delay: async () => {} },
    )).toMatchObject({ meetingId: 'meeting-2' });
  });
});
