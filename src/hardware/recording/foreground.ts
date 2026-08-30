import { Platform } from 'react-native';

import {
  MainaRecorder,
  type AudioInput,
  type AudioRouteChangedEvent,
  type CaptureState,
  type NativeCaptureSourceMode,
  type NativeCaptureDirectoryInspection,
  type NativePostProcessingRequest,
  type NativePostProcessingResult,
  type NativePostProcessingChangedEvent,
  type NativeCaptureStatus,
  type QwenAsrResult,
  type QwenAsrStatus,
  type RemoteControlStatus,
} from '../../../modules/maina-recorder/src';

function requireRecorderModule() {
  if (!MainaRecorder) {
    throw new Error('MainaRecorder native module is unavailable');
  }
  return MainaRecorder;
}

/** iOS uses AVAudioSession directly and therefore must not request the
 * unrelated Speech Recognition entitlement just to begin durable recording. */
export async function requestNativeCapturePermission(): Promise<boolean> {
  if (Platform.OS !== 'ios') return true;
  if (!MainaRecorder?.requestIOSMicrophonePermission) return false;
  return MainaRecorder.requestIOSMicrophonePermission();
}

export function getIOSAutomationScenario(): string | null {
  if (Platform.OS !== 'ios' || !MainaRecorder?.getIOSAutomationScenario) return null;
  return MainaRecorder.getIOSAutomationScenario();
}

export async function startRecordingForegroundService(): Promise<void> {
  // Android needs a foreground service to retain microphone ownership. iOS
  // retains an active AVAudioSession through the `audio` background mode, so
  // this capability is intentionally a no-op there.
  if (Platform.OS !== 'android') return;
  const started = await requireRecorderModule().startForegroundSession();
  if (!started) throw new Error('Android did not start the recording service');
}

export async function stopRecordingForegroundService(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) {
    await MainaRecorder.stopForegroundSession();
  }
}

export async function armRemoteControl(): Promise<RemoteControlStatus> {
  if (Platform.OS !== 'android') {
    throw new Error('Generic Bluetooth remote control is not supported on iPhone.');
  }
  return requireRecorderModule().armRemoteControl();
}

export async function disarmRemoteControl(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) await MainaRecorder.disarmRemoteControl();
}

export async function setNativeCaptureState(state: CaptureState): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) await MainaRecorder.setCaptureState(state);
}

export async function startNativeCapture(options: {
  meetingId: string;
  directory: string;
  sourceMode?: NativeCaptureSourceMode;
  chunkDurationMs?: number;
  meetingStartedAt: number;
}): Promise<void> {
  await requireRecorderModule().startNativeCapture(
    options.meetingId,
    options.directory,
    options.sourceMode ?? 'voice_recognition',
    options.chunkDurationMs ?? 5 * 60_000,
    options.meetingStartedAt,
  );
}

export async function pauseNativeCapture(): Promise<void> {
  await requireRecorderModule().pauseNativeCapture();
}

export async function resumeNativeCapture(): Promise<void> {
  await requireRecorderModule().resumeNativeCapture();
}

export async function stopNativeCapture(): Promise<void> {
  await requireRecorderModule().stopNativeCapture();
}

export async function abortNativeCapture(): Promise<void> {
  await requireRecorderModule().abortNativeCapture();
}

export async function startNativePostProcessing(request: NativePostProcessingRequest): Promise<void> {
  await requireRecorderModule().startNativePostProcessing(request);
}

export async function readNativePostProcessingResult(meetingId: string): Promise<NativePostProcessingResult | null> {
  if (!MainaRecorder) return null;
  return MainaRecorder.readNativePostProcessingResult(meetingId);
}

export async function acknowledgeNativePostProcessingResult(meetingId: string, runId: string): Promise<boolean> {
  if (!MainaRecorder) return false;
  const result = await MainaRecorder.acknowledgeNativePostProcessingResult(meetingId, runId);
  return result.acknowledged;
}

export function getNativeCaptureStatus(): NativeCaptureStatus | null {
  if (!MainaRecorder) return null;
  return MainaRecorder.getNativeCaptureStatus();
}

/**
 * Reads capture state without blocking React Native's JavaScript thread on
 * iOS. Android keeps its existing synchronous service snapshot because its
 * native implementation is already non-blocking and lock-screen qualified.
 */
export async function getNativeCaptureStatusAsync(): Promise<NativeCaptureStatus | null> {
  if (!MainaRecorder) return null;
  if (Platform.OS === 'ios' && MainaRecorder.getNativeCaptureStatusAsync) {
    return MainaRecorder.getNativeCaptureStatusAsync();
  }
  return MainaRecorder.getNativeCaptureStatus();
}

export async function inspectNativeCaptureDirectory(
  directory: string,
  recoverPartials = false,
): Promise<NativeCaptureDirectoryInspection> {
  return requireRecorderModule().inspectNativeCaptureDirectory(directory, recoverPartials);
}

export async function deleteNativeCaptureDirectory(directory: string): Promise<boolean> {
  if (!MainaRecorder || !directory) return false;
  return MainaRecorder.deleteNativeCaptureDirectory(directory);
}

export async function getQwenAsrStatus(): Promise<QwenAsrStatus | null> {
  if (!MainaRecorder) return null;
  return MainaRecorder.getQwenAsrStatus();
}

export async function transcribeWithQwen(uri: string, startMs: number, endMs: number): Promise<QwenAsrResult> {
  return requireRecorderModule().transcribeWithQwen(uri, startMs, endMs);
}

export async function releaseQwenAsr(): Promise<void> {
  if (MainaRecorder) await MainaRecorder.releaseQwenAsr();
}

export function beginIOSContinuedProcessing(meetingId: string, totalUnits: number): void {
  if (Platform.OS !== 'ios' || !MainaRecorder?.beginIOSContinuedProcessing) return;
  const result = MainaRecorder.beginIOSContinuedProcessing(
    meetingId,
    'Preparing meeting transcript',
    'Maina is processing saved audio on this iPhone.',
    Math.max(1, totalUnits),
  );
  // The request identifier is intentionally omitted from logs. Mode/reason are
  // enough to diagnose OS acceptance without retaining a meeting identifier.
  console.info('[MainaContinuedProcessing] begin', {
    started: result.started,
    mode: result.mode,
    reason: result.reason ?? null,
  });
}

export function updateIOSContinuedProcessing(completedUnits: number, totalUnits: number): void {
  if (Platform.OS !== 'ios' || !MainaRecorder?.updateIOSContinuedProcessing) return;
  const completed = Math.max(0, completedUnits);
  const total = Math.max(1, totalUnits);
  MainaRecorder.updateIOSContinuedProcessing(completed, total, `${completed} of ${total} audio windows checked`);
}

export function finishIOSContinuedProcessing(success: boolean): void {
  if (Platform.OS !== 'ios' || !MainaRecorder?.finishIOSContinuedProcessing) return;
  MainaRecorder.finishIOSContinuedProcessing(success);
}

export function isIOSContinuedProcessingActive(meetingId: string): boolean {
  if (Platform.OS !== 'ios') return true;
  return MainaRecorder?.isIOSContinuedProcessingActive?.(meetingId) ?? false;
}

export async function getRemoteControlStatus(): Promise<RemoteControlStatus | null> {
  if (Platform.OS !== 'android' || !MainaRecorder) return null;
  return MainaRecorder.getRemoteControlStatus();
}

export async function openRemoteAccessibilitySettings(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) await MainaRecorder.openRemoteAccessibilitySettings();
}

export function isRecordingForegroundServiceRunning(): boolean {
  return Platform.OS === 'android' && !!MainaRecorder?.isForegroundSessionRunning();
}

export function isNativePostProcessingServiceRunning(): boolean {
  return Platform.OS === 'android' && !!MainaRecorder?.isNativePostProcessingServiceRunning?.();
}

export async function repairWavFiles(uris: string[]): Promise<number> {
  if (!MainaRecorder || uris.length === 0) return 0;
  return MainaRecorder.repairWavFiles(uris);
}

export async function getPcmWavDurationsMs(uris: string[]): Promise<Record<string, number | null>> {
  if (!MainaRecorder || uris.length === 0) return {};
  return MainaRecorder.getPcmWavDurationsMs(uris);
}

export async function listAudioInputs(): Promise<AudioInput[]> {
  if (!MainaRecorder) return [];
  return MainaRecorder.getAudioInputs();
}

export function subscribeAudioRouteChanges(
  listener: (event: AudioRouteChangedEvent) => void,
): () => void {
  if (!MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onAudioRouteChanged', listener);
  return () => subscription.remove();
}

export function subscribeNativePostProcessingChanges(
  listener: (event: NativePostProcessingChangedEvent) => void,
): () => void {
  if (!MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onNativePostProcessingChanged', listener);
  return () => subscription.remove();
}
