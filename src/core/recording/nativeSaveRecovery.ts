import type { NativeCaptureStatus } from '../../../modules/maina-recorder/src';

export type NativeSaveRecoveryMode =
  | 'check_terminal_status'
  | 'retry_terminal_once'
  | 'retry_stop_submission_once'
  | 'resume_checkpoint'
  | 'restart_required';

export type NativeSaveEntryAction = 'begin_stop' | NativeSaveRecoveryMode | 'ignore';

export type NativeSaveStatusClassification =
  | 'complete'
  | 'pending'
  | 'retryable_once'
  | 'submission_retryable_once'
  | 'restart_required';

export type NativeSavePresentationSurface = 'busy' | 'error' | 'recording';
export type NativeTerminalIntent = 'save' | 'discard';

export interface NativeTerminalRecoveryWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function nativeSavePresentationSurface(input: {
  busy: boolean;
  error: string | null;
}): NativeSavePresentationSurface {
  if (input.busy) return 'busy';
  if (input.error) return 'error';
  return 'recording';
}

export function nativeTerminalIntentAdmission(input: {
  current: NativeTerminalIntent | null;
  requested: NativeTerminalIntent;
  continuation: boolean;
}): boolean {
  return input.continuation
    ? input.current === input.requested
    : input.current === null;
}

export class NativeTerminalIntentLatch {
  private owner: NativeTerminalIntent | null = null;

  current(): NativeTerminalIntent | null {
    return this.owner;
  }

  tryBegin(requested: NativeTerminalIntent): boolean {
    if (!nativeTerminalIntentAdmission({ current: this.owner, requested, continuation: false })) return false;
    this.owner = requested;
    return true;
  }

  acceptsContinuation(requested: NativeTerminalIntent): boolean {
    return nativeTerminalIntentAdmission({ current: this.owner, requested, continuation: true });
  }
}

export function nativeSaveEntryAction(input: {
  saving: boolean;
  recoveryMode: NativeSaveRecoveryMode | null;
  statusCheckBusy: boolean;
}): NativeSaveEntryAction {
  if (!input.saving) return 'begin_stop';
  if (input.recoveryMode && !input.statusCheckBusy) return input.recoveryMode;
  return 'ignore';
}

/**
 * Converts the native service's bounded public terminal state into one exact
 * recovery action. Android requires the service-owned terminal publication;
 * iOS requires its exact recorder-callback-bound terminal receipt after live
 * capture ownership has been cleared at idle.
 */
export function classifyNativeSaveStatus(input: {
  status: NativeCaptureStatus | null;
  expectedMeetingId: string;
  platform: 'android' | 'ios';
  retryAvailable: boolean;
  submissionRetryAvailable?: boolean;
}): NativeSaveStatusClassification {
  const { status, expectedMeetingId, platform, retryAvailable, submissionRetryAvailable = false } = input;
  if (!status || !expectedMeetingId) {
    return 'restart_required';
  }
  if (platform === 'ios') {
    return status.state === 'idle'
      && status.meetingId == null
      && status.terminalMeetingId === expectedMeetingId
      && status.terminalReceiptSchemaVersion === 'maina.ios-native-stop.v1'
      && Number.isSafeInteger(status.terminalGeneration)
      && (status.terminalGeneration ?? 0) > 0
      && status.terminalDisposition === 'save'
      && status.terminalPublicationState === 'succeeded'
      && status.terminalReasonCode === 'stop_succeeded'
      && status.lastError == null
      && Number.isSafeInteger(status.terminalSegmentCount)
      && (status.terminalSegmentCount ?? 0) > 0
      && Number.isSafeInteger(status.terminalAudioBytes)
      && (status.terminalAudioBytes ?? 0) > 0
      ? 'complete'
      : 'restart_required';
  }
  if (status.meetingId !== expectedMeetingId) {
    return 'restart_required';
  }
  if (status.state === 'idle') {
    return status.terminalPublicationState === 'succeeded'
      && status.terminalReasonCode === 'stop_succeeded'
      ? 'complete'
      : 'restart_required';
  }
  if (status.state === 'finalizing' && (
    (status.terminalPublicationState === 'queued' && status.terminalReasonCode === 'stop_queued')
    || (status.terminalPublicationState === 'running' && status.terminalReasonCode === 'stop_running')
  )) {
    return 'pending';
  }
  if (
    platform === 'android'
    && status.state === 'error'
    && status.terminalPublicationState === 'recovery_required'
    && status.terminalReasonCode === 'stop_timeout_or_error'
  ) {
    return retryAvailable ? 'retryable_once' : 'restart_required';
  }
  if (
    platform === 'android'
    && submissionRetryAvailable
    && ['recording', 'paused'].includes(status.state)
    && (status.terminalPublicationState === 'none' || status.terminalPublicationState == null)
    && (status.terminalReasonCode === 'no_terminal_operation' || status.terminalReasonCode == null)
  ) {
    return 'submission_retryable_once';
  }
  return 'restart_required';
}

export function recoveryModeForClassification(
  classification: Exclude<NativeSaveStatusClassification, 'complete'>,
): NativeSaveRecoveryMode {
  if (classification === 'pending') return 'check_terminal_status';
  if (classification === 'retryable_once') return 'retry_terminal_once';
  if (classification === 'submission_retryable_once') return 'retry_stop_submission_once';
  return 'restart_required';
}

/**
 * A foreground-service command is delivered asynchronously after its bridge
 * Promise resolves. Tolerate only the exact prior recovery-required snapshot
 * until the bounded overall deadline; once a newer operation is visible,
 * return its first terminal result. Unknown identity or expiry closes.
 */
export async function waitForNativeTerminalRecovery(
  getStatus: () => NativeCaptureStatus | null | Promise<NativeCaptureStatus | null>,
  input: { expectedMeetingId: string; priorOperationId: number },
  options: NativeTerminalRecoveryWaitOptions = {},
): Promise<NativeCaptureStatus | null> {
  if (!input.expectedMeetingId || !Number.isSafeInteger(input.priorOperationId) || input.priorOperationId < 1) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? sleep;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let lastStatus: NativeCaptureStatus | null = null;
  let observedNewOperation = false;

  while (now() <= deadline) {
    lastStatus = await getStatus();
    if (!lastStatus || lastStatus.meetingId !== input.expectedMeetingId) return lastStatus;
    const operationId = lastStatus.terminalOperationId;
    if (Number.isSafeInteger(operationId) && Number(operationId) > input.priorOperationId) {
      observedNewOperation = true;
    }
    if (observedNewOperation && (lastStatus.state === 'idle' || lastStatus.state === 'error')) {
      return lastStatus;
    }
    await delay(pollMs);
  }
  return lastStatus;
}
