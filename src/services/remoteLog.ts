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
  type DiagnosticsPurgeResult,
  type NativeDiagnosticEvent,
  type TextArtifactRequest,
} from '../../modules/maina-recorder/src';
import { log, type LogEntry } from './logger';
import { compactNativeValue } from './nativePayload';
import { REMOTE_LOG } from './remoteConfig';
import {
  diagnosticSuppressionSourcesActive,
  normalizeQualificationMeetingIds,
  qualificationDiagnosticSuppressed,
  referencesQualificationMeeting,
} from '@/core/recording/qualificationDiagnostics';

interface DiagnosticContext {
  meetingId?: string | null;
  recordingSessionId?: string | null;
  segmentIndex?: number | null;
}

let sinkInstalled = false;
let configured = false;
let configurationAttempt: Promise<void> | null = null;
let sequence = 0;
let context: DiagnosticContext = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
let qualificationDiagnosticsSuppressed = false;
let qualificationMeetingIds = new Set<string>();
let quarantineMeetingIds = new Set<string>();
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
  const payload = compactNativeValue(entry.context) as Record<string, unknown> | undefined;
  const event: NativeDiagnosticEvent = {
    eventId: id(),
    occurredAt: new Date(entry.ts).toISOString(),
    elapsedMs: Math.max(0, Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)),
    sequence,
    level: entry.level,
    category: entry.scope,
    eventName: eventName(entry.message),
    message: entry.message,
    ...(context.meetingId ? { meetingId: context.meetingId } : {}),
    ...(context.recordingSessionId ? { recordingSessionId: context.recordingSessionId } : {}),
    ...(typeof context.segmentIndex === 'number' ? { segmentIndex: context.segmentIndex } : {}),
    ...(typeof payload?.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
    ...(payload ? { payload } : {}),
  };
  return event;
}

function suppressed(...values: unknown[]): boolean {
  const protectedMeetingIds = new Set([...qualificationMeetingIds, ...quarantineMeetingIds]);
  return qualificationDiagnosticSuppressed({
    globallySuppressed: diagnosticsGloballySuppressed(),
    qualificationMeetingIds: protectedMeetingIds,
    values: [context, ...values],
  });
}

function diagnosticsGloballySuppressed(): boolean {
  return diagnosticSuppressionSourcesActive({
    qualificationActive: qualificationDiagnosticsSuppressed,
    quarantineMeetingIds,
  });
}

function removePendingProtectedEvents(): void {
  const protectedMeetingIds = new Set([...qualificationMeetingIds, ...quarantineMeetingIds]);
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (referencesQualificationMeeting(pending[index], protectedMeetingIds)) pending.splice(index, 1);
  }
}

async function drain(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (diagnosticsGloballySuppressed() || draining || !configured || !MainaRecorder || pending.length === 0) return;
  draining = true;
  const batch = pending.splice(0, 50);
  try {
    await MainaRecorder.enqueueDiagnosticEvents(batch);
  } catch {
    pending.unshift(...batch);
    if (pending.length > 2000) pending.splice(0, pending.length - 2000);
  } finally {
    draining = false;
  }
  if (pending.length > 0) scheduleDrain();
}

function scheduleDrain(immediate = false): void {
  if (timer) return;
  timer = setTimeout(() => void drain(), immediate ? 0 : 30_000);
}

export async function installRemoteLog(): Promise<void> {
  if (Platform.OS !== 'android' || !MainaRecorder || !REMOTE_LOG.enabled) return;

  if (!sinkInstalled) {
    sinkInstalled = true;
    log.addSink((entry) => {
      if (suppressed(entry)) return;
      pending.push(toNativeEvent(entry));
      scheduleDrain(entry.level === 'error' || entry.level === 'warn' || pending.length >= 50);
    });
  }
  if (configured) return;
  if (configurationAttempt) return configurationAttempt;

  const attempt = (async () => {
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
    } finally {
      configurationAttempt = null;
    }
  })();
  configurationAttempt = attempt;
  return attempt;
}

export function setDiagnosticContext(next: DiagnosticContext): void {
  context = { ...context, ...next };
}

export function clearDiagnosticContext(): void {
  context = {};
}

export function setQualificationDiagnosticsSuppressed(suppressed: boolean): void {
  qualificationDiagnosticsSuppressed = suppressed;
  if (suppressed) clearDiagnosticContext();
  else if (!diagnosticsGloballySuppressed() && pending.length > 0) scheduleDrain(true);
}

export function setQualificationDiagnosticMeetingIds(meetingIds: readonly unknown[]): void {
  qualificationMeetingIds = normalizeQualificationMeetingIds(meetingIds);
  removePendingProtectedEvents();
}

export function addQualificationDiagnosticMeetingId(meetingId: string): void {
  if (meetingId.length < 1 || meetingId.length > 128) return;
  qualificationMeetingIds.add(meetingId);
  removePendingProtectedEvents();
}

/**
 * Reconciles the legacy native-capture privacy fence on every startup and
 * background pass. An empty exact set actively releases quarantine-only
 * suppression after Recover or Discard resolves the durable owner.
 */
export function setQuarantineDiagnosticMeetingIds(meetingIds: readonly unknown[]): void {
  quarantineMeetingIds = normalizeQualificationMeetingIds(meetingIds);
  if (quarantineMeetingIds.size > 0) clearDiagnosticContext();
  removePendingProtectedEvents();
  if (!diagnosticsGloballySuppressed() && pending.length > 0) scheduleDrain(true);
}

export async function queueAudioArtifact(request: AudioArtifactRequest): Promise<string | null> {
  if (suppressed(request) || !configured || !MainaRecorder) return null;
  return MainaRecorder.queueAudioArtifact(request);
}

export async function queueTextArtifact(request: TextArtifactRequest): Promise<string | null> {
  if (suppressed(request) || !configured || !MainaRecorder) return null;
  return MainaRecorder.queueTextArtifact(request);
}

export async function finalizeDiagnosticRun(summary: DiagnosticRunSummary): Promise<void> {
  if (suppressed(summary) || !configured || !MainaRecorder) return;
  await drain();
  await MainaRecorder.finalizeDiagnosticRun(compactNativeValue(summary) as DiagnosticRunSummary);
}

export async function flushDiagnostics(): Promise<void> {
  if (diagnosticsGloballySuppressed()) return;
  await drain();
  if (configured && MainaRecorder) await MainaRecorder.flushDiagnostics();
}

export async function retryFailedDiagnosticArtifacts(): Promise<number> {
  if (diagnosticsGloballySuppressed() || !configured || !MainaRecorder) return 0;
  return MainaRecorder.retryFailedDiagnosticArtifacts();
}

export async function getDiagnosticsStatus(): Promise<DiagnosticsStatus | null> {
  if (diagnosticsGloballySuppressed() || !MainaRecorder || Platform.OS !== 'android') return null;
  return MainaRecorder.getDiagnosticsStatus();
}

export async function getMeetingsWithDeletedAudio(): Promise<string[]> {
  if (!MainaRecorder || Platform.OS !== 'android') return [];
  return MainaRecorder.getMeetingsWithDeletedAudio();
}

export async function purgeDiagnosticsData(): Promise<DiagnosticsPurgeResult | null> {
  if (!MainaRecorder || Platform.OS !== 'android') return null;
  return MainaRecorder.purgeDiagnosticsData();
}
