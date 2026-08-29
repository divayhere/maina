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

function requireAndroidModule() {
  if (Platform.OS !== 'android' || !MainaRecorder) {
    throw new Error('MainaRecorder native module is unavailable');
  }
  return MainaRecorder;
}

export async function startRecordingForegroundService(): Promise<void> {
  const started = await requireAndroidModule().startForegroundSession();
  if (!started) throw new Error('Android did not start the recording service');
}

export async function stopRecordingForegroundService(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) {
    await MainaRecorder.stopForegroundSession();
  }
}

export async function armRemoteControl(): Promise<RemoteControlStatus> {
  return requireAndroidModule().armRemoteControl();
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
  await requireAndroidModule().startNativeCapture(
    options.meetingId,
    options.directory,
    options.sourceMode ?? 'voice_recognition',
    options.chunkDurationMs ?? 5 * 60_000,
    options.meetingStartedAt,
  );
}

export async function pauseNativeCapture(): Promise<void> {
  await requireAndroidModule().pauseNativeCapture();
}

export async function resumeNativeCapture(): Promise<void> {
  await requireAndroidModule().resumeNativeCapture();
}

export async function stopNativeCapture(): Promise<void> {
  await requireAndroidModule().stopNativeCapture();
}

export async function abortNativeCapture(): Promise<void> {
  await requireAndroidModule().abortNativeCapture();
}

export async function startNativePostProcessing(request: NativePostProcessingRequest): Promise<void> {
  await requireAndroidModule().startNativePostProcessing(request);
}

export function isNativePostProcessingServiceRunning(): boolean {
  return Platform.OS === 'android'
    && !!MainaRecorder?.isNativePostProcessingServiceRunning();
}

export async function readNativePostProcessingResult(meetingId: string): Promise<NativePostProcessingResult | null> {
  if (Platform.OS !== 'android' || !MainaRecorder) return null;
  return MainaRecorder.readNativePostProcessingResult(meetingId);
}

export async function acknowledgeNativePostProcessingResult(meetingId: string, runId: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !MainaRecorder) return false;
  const result = await MainaRecorder.acknowledgeNativePostProcessingResult(meetingId, runId);
  return result.acknowledged;
}

export function getNativeCaptureStatus(): NativeCaptureStatus | null {
  if (Platform.OS !== 'android' || !MainaRecorder) return null;
  return MainaRecorder.getNativeCaptureStatus();
}

export async function inspectNativeCaptureDirectory(
  directory: string,
  recoverPartials = false,
): Promise<NativeCaptureDirectoryInspection> {
  return requireAndroidModule().inspectNativeCaptureDirectory(directory, recoverPartials);
}

export async function deleteNativeCaptureDirectory(directory: string): Promise<boolean> {
  if (Platform.OS !== 'android' || !MainaRecorder || !directory) return false;
  return MainaRecorder.deleteNativeCaptureDirectory(directory);
}

export async function getQwenAsrStatus(): Promise<QwenAsrStatus | null> {
  if (Platform.OS !== 'android' || !MainaRecorder) return null;
  return MainaRecorder.getQwenAsrStatus();
}

export async function transcribeWithQwen(uri: string, startMs: number, endMs: number): Promise<QwenAsrResult> {
  return requireAndroidModule().transcribeWithQwen(uri, startMs, endMs);
}

export async function releaseQwenAsr(): Promise<void> {
  if (Platform.OS === 'android' && MainaRecorder) await MainaRecorder.releaseQwenAsr();
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

export async function repairWavFiles(uris: string[]): Promise<number> {
  if (Platform.OS !== 'android' || !MainaRecorder || uris.length === 0) return 0;
  return MainaRecorder.repairWavFiles(uris);
}

export async function getPcmWavDurationsMs(uris: string[]): Promise<Record<string, number | null>> {
  if (Platform.OS !== 'android' || !MainaRecorder || uris.length === 0) return {};
  return MainaRecorder.getPcmWavDurationsMs(uris);
}

export async function listAudioInputs(): Promise<AudioInput[]> {
  if (Platform.OS !== 'android' || !MainaRecorder) return [];
  return MainaRecorder.getAudioInputs();
}

export function subscribeAudioRouteChanges(
  listener: (event: AudioRouteChangedEvent) => void,
): () => void {
  if (Platform.OS !== 'android' || !MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onAudioRouteChanged', listener);
  return () => subscription.remove();
}

export function subscribeNativePostProcessingChanges(
  listener: (event: NativePostProcessingChangedEvent) => void,
): () => void {
  if (Platform.OS !== 'android' || !MainaRecorder) return () => {};
  const subscription = MainaRecorder.addListener('onNativePostProcessingChanged', listener);
  return () => subscription.remove();
}
