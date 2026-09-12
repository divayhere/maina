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

function isExactPreDeliveryStatus(status: NativeCaptureStatus): boolean {
  return ['recording', 'paused'].includes(status.state)
    && (status.terminalPublicationState === 'none' || status.terminalPublicationState == null)
    && (status.terminalReasonCode === 'no_terminal_operation' || status.terminalReasonCode == null);
}

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
 * iOS has no equivalent publication field and proves completion with its
 * meeting-bound idle snapshot.
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
  if (status.meetingId !== expectedMeetingId) {
    return 'restart_required';
  }
  if (status.state === 'idle') {
    if (platform === 'ios') return 'complete';
    if (status.terminalPublicationState === 'succeeded'
      && status.terminalReasonCode === 'stop_succeeded'
    ) return 'complete';
    // NativeAudioCapture publishes its stopped/idle snapshot from the capture
    // executor before the service reducer can durably publish stop_succeeded on
    // the main looper. This one exact tuple is transitional, not recovery.
    if (status.terminalPublicationState === 'running'
      && status.terminalReasonCode === 'stop_running'
    ) return 'pending';
    return 'restart_required';
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

/**
 * Waits for the meeting-bound terminal receipt, not merely the native recorder's
 * earlier idle snapshot. Before command delivery Android can still report the
 * previous recording/paused state; after delivery only exact pending tuples may
 * remain in the loop. Identity or tuple drift returns immediately and therefore
 * still fails closed in classifyNativeSaveStatus.
 */
export async function waitForNativeSaveResolution(
  getStatus: () => NativeCaptureStatus | null | Promise<NativeCaptureStatus | null>,
  input: { expectedMeetingId: string; platform: 'android' | 'ios' },
  options: NativeTerminalRecoveryWaitOptions = {},
): Promise<NativeCaptureStatus | null> {
  if (!input.expectedMeetingId) return null;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? sleep;
  const deadline = now() + timeoutMs;
  let lastStatus: NativeCaptureStatus | null = null;

  while (now() <= deadline) {
    lastStatus = await getStatus();
    if (!lastStatus || lastStatus.meetingId !== input.expectedMeetingId) return lastStatus;
    if (input.platform === 'ios') {
      if (lastStatus.state === 'idle' || lastStatus.state === 'error') return lastStatus;
    } else {
      const classification = classifyNativeSaveStatus({
        status: lastStatus,
        expectedMeetingId: input.expectedMeetingId,
        platform: 'android',
        retryAvailable: true,
        submissionRetryAvailable: true,
      });
      if (classification === 'complete' || classification === 'retryable_once') return lastStatus;
      if (classification !== 'pending' && !isExactPreDeliveryStatus(lastStatus)) return lastStatus;
    }
    await delay(pollMs);
  }

  return getStatus();
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
    if (observedNewOperation) {
      const classification = classifyNativeSaveStatus({
        status: lastStatus,
        expectedMeetingId: input.expectedMeetingId,
        platform: 'android',
        retryAvailable: false,
      });
      if (classification === 'complete' || classification === 'restart_required') return lastStatus;
    }
    await delay(pollMs);
  }
  return lastStatus;
}
