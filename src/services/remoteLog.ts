/** Durable native diagnostics bridge. Supabase is the remote timeline; the
 * Android outbox is the source of truth while offline or after process death. */
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import {
  MainaRecorder,
  type AudioArtifactRequest,
  type DiagnosticRunSummary,
  type DiagnosticsStatus,
  type NativeDiagnosticEvent,
  type TextArtifactRequest,
} from '../../modules/maina-recorder/src';
import { log, type LogEntry } from './logger';
import { REMOTE_LOG } from './remoteConfig';

interface DiagnosticContext {
  meetingId?: string | null;
  recordingSessionId?: string | null;
  segmentIndex?: number | null;
}

let installed = false;
let configured = false;
let sequence = 0;
let context: DiagnosticContext = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const pending: NativeDiagnosticEvent[] = [];
const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
const appSessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;

function id(): string {
  return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function eventName(message: string): string {
  return message.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'event';
}

function toNativeEvent(entry: LogEntry): NativeDiagnosticEvent {
  sequence += 1;
  const payload = entry.context ?? null;
  return {
    eventId: id(),
    occurredAt: new Date(entry.ts).toISOString(),
    elapsedMs: Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)),
    sequence,
    level: entry.level,
    category: entry.scope,
    eventName: eventName(entry.message),
    message: entry.message,
    meetingId: context.meetingId ?? null,
    recordingSessionId: context.recordingSessionId ?? null,
    segmentIndex: context.segmentIndex ?? null,
    durationMs: typeof payload?.durationMs === 'number' ? payload.durationMs : null,
    payload,
  };
}

async function drain(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!configured || !MainaRecorder || pending.length === 0) return;
  const batch = pending.splice(0, 50);
  try {
    await MainaRecorder.enqueueDiagnosticEvents(batch);
  } catch {
    pending.unshift(...batch);
    if (pending.length > 2000) pending.splice(0, pending.length - 2000);
  }
  if (pending.length > 0) scheduleDrain();
}

function scheduleDrain(immediate = false): void {
  if (timer) return;
  timer = setTimeout(() => void drain(), immediate ? 0 : 250);
}

export async function installRemoteLog(): Promise<void> {
  if (installed) return;
  installed = true;
  if (Platform.OS !== 'android' || !MainaRecorder || !REMOTE_LOG.enabled) return;

  log.addSink((entry) => {
    pending.push(toNativeEvent(entry));
    scheduleDrain(entry.level === 'error');
  });

  try {
    await MainaRecorder.configureDiagnostics({
      enabled: true,
      supabaseUrl: REMOTE_LOG.url,
      publishableKey: REMOTE_LOG.publishableKey,
      bucket: REMOTE_LOG.bucket,
      appVersion: Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '?',
      buildNumber: Constants.nativeBuildVersion ?? '?',
      gitSha: process.env.EXPO_PUBLIC_GIT_SHA ?? 'local-unset',
      device: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim() || 'unknown',
      platform: `${Platform.OS} ${Device.osVersion ?? ''}`.trim(),
      appSessionId,
      retentionDays: REMOTE_LOG.retentionDays,
    });
    configured = true;
    await drain();
    log.info('remote', 'durable diagnostics online', { appSessionId });
  } catch (cause) {
    configured = false;
    log.warn('remote', 'diagnostics configuration failed', { err: String(cause) });
  }
}

export function setDiagnosticContext(next: DiagnosticContext): void {
  context = { ...context, ...next };
}

export function clearDiagnosticContext(): void {
  context = {};
}

export async function queueAudioArtifact(request: AudioArtifactRequest): Promise<string | null> {
  if (!configured || !MainaRecorder) return null;
  return MainaRecorder.queueAudioArtifact(request);
}

export async function queueTextArtifact(request: TextArtifactRequest): Promise<string | null> {
  if (!configured || !MainaRecorder) return null;
  return MainaRecorder.queueTextArtifact(request);
}

export async function finalizeDiagnosticRun(summary: DiagnosticRunSummary): Promise<void> {
  if (!configured || !MainaRecorder) return;
  await drain();
  await MainaRecorder.finalizeDiagnosticRun(summary);
}

export async function flushDiagnostics(): Promise<void> {
  await drain();
  if (configured && MainaRecorder) await MainaRecorder.flushDiagnostics();
}

export async function retryFailedDiagnosticArtifacts(): Promise<number> {
  if (!configured || !MainaRecorder) return 0;
  return MainaRecorder.retryFailedDiagnosticArtifacts();
}

export async function getDiagnosticsStatus(): Promise<DiagnosticsStatus | null> {
  if (!MainaRecorder || Platform.OS !== 'android') return null;
  return MainaRecorder.getDiagnosticsStatus();
}

export async function getMeetingsWithDeletedAudio(): Promise<string[]> {
  if (!MainaRecorder || Platform.OS !== 'android') return [];
  return MainaRecorder.getMeetingsWithDeletedAudio();
}
