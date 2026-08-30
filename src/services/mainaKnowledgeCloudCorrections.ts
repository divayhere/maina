import {
  getKnowledgeCloudCorrection,
  getLatestKnowledgeCloudCorrection,
  getMeeting,
  insertKnowledgeCloudCorrection,
  listKnowledgeCloudCorrectionsEligibleForQueue,
  listKnowledgeCloudCorrectionsNeedingSync,
  listKnowledgeCloudCorrections,
  listMeetingKnowledgeCloudCorrectionsNeedingSync,
  persistKnowledgeCloudCorrectionRetry,
  updateKnowledgeCloudCorrection,
  type KnowledgeCloudCorrection,
} from '@/data/meetings';
import { getMainaKnowledgeCloudSettings } from '@/services/config';
import { log } from '@/services/logger';
import { clearMainaCloudSession, mainaCloudRequestJson } from '@/services/mainaCloudSession';
import { classifyTransportCause, safeCloudFailureMessage } from '@/core/pipeline/cloudFailure';
import { armPipelineNetworkRecovery } from '@/services/pipelineWakeScheduler';
import { isRetryableCloudFailure, nextCloudRetry } from '@/services/cloudRetryPolicy';
import {
  buildMainaKnowledgeCloudCorrectionPackage,
  packetCorrectionSnapshots,
  sourceFieldFingerprint,
  type MeetingPacketCorrectionValues,
} from './mainaKnowledgeCloudCorrectionsCore';
import { classifyMainaKnowledgeCloudResponse } from './mainaKnowledgeCloudCore';

const inflight = new Map<string, Promise<void>>();

async function syncCorrection(correctionKey: string): Promise<void> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return;

  const correction = await getKnowledgeCloudCorrection(correctionKey);
  if (!correction) return;
  const meeting = await getMeeting(correction.meetingId);
  if (!meeting || meeting.knowledgeCloudSyncStatus !== 'sync_succeeded') return;
  if (correction.syncStatus === 'sync_succeeded') return;
  if (correction.syncStatus === 'sync_failed_auth') return;
  if (correction.syncStatus === 'sync_failed_conflict') return;
  if (correction.syncStatus === 'sync_failed_validation') return;
  if ((correction.syncStatus === 'sync_failed_retryable'
      || correction.syncStatus === 'sync_blocked_budget')
    && correction.nextRetryAt != null
    && correction.nextRetryAt > Date.now()) return;

  await armPipelineNetworkRecovery();

  await updateKnowledgeCloudCorrection(correctionKey, {
    syncStatus: 'syncing',
    lastAttemptAt: Date.now(),
    error: null,
  });

  try {
    const response = await mainaCloudRequestJson('/v1/corrections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: correction.payloadJson,
      }, { acceptHttpErrors: true });
    const result = classifyMainaKnowledgeCloudResponse({
      status: response.status,
      body: response.data,
    });

    if (result.outcome === 'success') {
      await updateKnowledgeCloudCorrection(correctionKey, {
        syncStatus: 'sync_succeeded',
        canonicalSha256: result.canonicalSha256 ?? null,
        syncedAt: Date.now(),
        error: null,
        failureClass: null,
        retryCount: 0,
        lastRetryAt: null,
        nextRetryAt: null,
      });
      log.info('maina-cloud-correction', 'meeting knowledge correction synced', {
        meetingId: correction.meetingId,
        correctionKey,
        fieldPath: correction.fieldPath,
        versionTag: correction.versionTag,
        status: response.status,
      });
      return;
    }

    const syncStatus = result.outcome === 'auth_failed'
      ? 'sync_failed_auth'
      : result.outcome === 'conflict'
        ? 'sync_failed_conflict'
        : result.outcome === 'validation'
          ? 'sync_failed_validation'
          : result.outcome === 'blocked_budget'
            ? 'sync_blocked_budget'
            : 'sync_failed_retryable';
    if (syncStatus === 'sync_failed_auth') await clearMainaCloudSession();
    const safeError = syncStatus === 'sync_failed_auth'
      ? safeCloudFailureMessage('auth')
      : syncStatus === 'sync_failed_retryable' || syncStatus === 'sync_blocked_budget'
        ? safeCloudFailureMessage('backend_retryable')
        : safeCloudFailureMessage('backend_terminal');
    if (syncStatus === 'sync_failed_retryable' || syncStatus === 'sync_blocked_budget') {
      const retry = nextCloudRetry({ attemptCount: correction.retryCount ?? 0 });
      await persistKnowledgeCloudCorrectionRetry({
        correctionKey,
        syncStatus,
        retryCount: retry.attemptCount,
        lastRetryAt: retry.lastRetryAt,
        nextRetryAt: retry.nextRetryAt,
        failureClass: 'backend_retryable',
        visibleError: safeError,
      });
    } else {
      await updateKnowledgeCloudCorrection(correctionKey, {
        syncStatus,
        error: safeError,
        failureClass: syncStatus === 'sync_failed_auth' ? 'auth' : 'backend_terminal',
      });
    }
  } catch (cause) {
    const classified = classifyTransportCause(cause);
    const retryable = isRetryableCloudFailure(cause);
    const failureClass = retryable || ['auth', 'http_terminal', 'backend_terminal', 'protocol'].includes(classified)
      ? classified
      : 'protocol';
    if (retryable) {
      const retry = nextCloudRetry({ attemptCount: correction.retryCount ?? 0 });
      await persistKnowledgeCloudCorrectionRetry({
        correctionKey,
        syncStatus: 'sync_failed_retryable',
        retryCount: retry.attemptCount,
        lastRetryAt: retry.lastRetryAt,
        nextRetryAt: retry.nextRetryAt,
        failureClass,
        visibleError: safeCloudFailureMessage(failureClass),
      });
    } else {
      if (failureClass === 'auth') await clearMainaCloudSession();
      await updateKnowledgeCloudCorrection(correctionKey, {
        syncStatus: failureClass === 'auth' ? 'sync_failed_auth' : 'sync_failed_validation',
        error: safeCloudFailureMessage(failureClass),
        failureClass,
        nextRetryAt: null,
      });
    }
    log.warn('maina-cloud-correction', 'meeting knowledge correction sync failed', {
      meetingId: correction.meetingId,
      correctionKey,
      failureClass,
      causeName: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}

export function runMainaKnowledgeCloudCorrectionSync(correctionKey: string): Promise<void> {
  const existing = inflight.get(correctionKey);
  if (existing) return existing;
  const task = syncCorrection(correctionKey).finally(() => inflight.delete(correctionKey));
  inflight.set(correctionKey, task);
  return task;
}

async function syncSequentially(corrections: KnowledgeCloudCorrection[]): Promise<number> {
  let attempted = 0;
  for (const correction of corrections) {
    await runMainaKnowledgeCloudCorrectionSync(correction.correctionKey);
    attempted += 1;
    const refreshed = await getKnowledgeCloudCorrection(correction.correctionKey);
    // Later correction versions may explicitly supersede this row. Never send
    // a descendant until its predecessor exists remotely, regardless of
    // whether the predecessor is retryable, auth-blocked, or terminally bad.
    if (refreshed?.syncStatus !== 'sync_succeeded') break;
  }
  return attempted;
}

export async function maybeQueueMainaKnowledgeCloudPacketCorrections(input: {
  meetingId: string;
  packet: MeetingPacketCorrectionValues;
  providerId?: string | null;
  model?: string | null;
}): Promise<number> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return 0;

  const meeting = await getMeeting(input.meetingId);
  const sourcePayloadJson = meeting?.knowledgeCloudPayloadJson?.trim();
  const sourceKey = meeting?.knowledgeCloudSourceKey?.trim();
  if (!meeting || !sourcePayloadJson || !sourceKey) {
    // No source has been frozen yet. The normal source sync will freeze the
    // newly generated packet, so emitting a correction here would duplicate it.
    return 0;
  }

  let inserted = 0;
  const occurredAt = Date.now();
  for (const snapshot of packetCorrectionSnapshots(input.packet)) {
    const baseline = sourceFieldFingerprint(sourcePayloadJson, snapshot.fieldPath);
    if (!baseline) continue;
    const latest = await getLatestKnowledgeCloudCorrection(input.meetingId, snapshot.fieldPath);
    const previousFingerprint = latest?.valueFingerprint ?? baseline.fingerprint;
    if (previousFingerprint === snapshot.valueFingerprint) continue;

    const versionNumber = latest
      ? latest.versionNumber + 1
      : baseline.hasBaselineValue
        ? 2
        : 1;
    const payload = buildMainaKnowledgeCloudCorrectionPackage({
      meetingId: input.meetingId,
      sourceKey,
      fieldPath: snapshot.fieldPath,
      body: snapshot.body,
      versionNumber,
      supersedesCorrectionKey: latest?.correctionKey ?? null,
      occurredAt,
      providerId: input.providerId,
      model: input.model,
    });
    const created = await insertKnowledgeCloudCorrection({
      correctionKey: payload.correction_key,
      meetingId: input.meetingId,
      sourceKey,
      fieldPath: snapshot.fieldPath,
      versionNumber,
      versionTag: payload.version_tag,
      supersedesCorrectionKey: payload.supersedes_correction_key ?? null,
      payloadJson: JSON.stringify(payload),
      valueFingerprint: snapshot.valueFingerprint,
    });
    if (created) inserted += 1;
  }

  if (inserted > 0) {
    log.info('maina-cloud-correction', 'meeting knowledge corrections frozen', {
      meetingId: input.meetingId,
      count: inserted,
    });
  }
  if (meeting.knowledgeCloudSyncStatus === 'sync_succeeded') {
    await reconcileMainaKnowledgeCloudCorrectionsForMeeting(input.meetingId);
  }
  return inserted;
}

export async function reconcileMainaKnowledgeCloudCorrectionsForMeeting(
  meetingId: string,
): Promise<number> {
  const pending = await listMeetingKnowledgeCloudCorrectionsNeedingSync(meetingId);
  return syncSequentially(pending);
}

export async function requeueMainaKnowledgeCloudCorrectionsForMeeting(
  meetingId: string,
  options?: { includeAuthFailures?: boolean },
): Promise<number> {
  const eligible = (await listKnowledgeCloudCorrections(meetingId)).filter((correction) =>
    correction.syncStatus === 'sync_failed_retryable'
    || correction.syncStatus === 'sync_blocked_budget'
    || correction.syncStatus === 'sync_queued'
    || correction.syncStatus === 'syncing'
    || (options?.includeAuthFailures === true && correction.syncStatus === 'sync_failed_auth'));
  for (const correction of eligible) {
    await updateKnowledgeCloudCorrection(correction.correctionKey, {
      syncStatus: 'sync_queued',
      error: null,
      nextRetryAt: null,
    });
  }
  await reconcileMainaKnowledgeCloudCorrectionsForMeeting(meetingId);
  return eligible.length;
}

export async function reconcilePendingMainaKnowledgeCloudCorrections(): Promise<number> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return 0;
  return syncSequentially(await listKnowledgeCloudCorrectionsNeedingSync());
}

export async function queueEligibleMainaKnowledgeCloudCorrections(options?: {
  includeAuthFailures?: boolean;
  forceRetry?: boolean;
}): Promise<number> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return 0;
  const corrections = await listKnowledgeCloudCorrectionsEligibleForQueue(options);
  const due = options?.forceRetry === true
    ? corrections
    : corrections.filter((correction) => correction.nextRetryAt == null || correction.nextRetryAt <= Date.now());
  for (const correction of due) {
    await updateKnowledgeCloudCorrection(correction.correctionKey, {
      syncStatus: 'sync_queued',
      error: null,
      nextRetryAt: options?.forceRetry === true ? null : correction.nextRetryAt,
    });
  }
  return syncSequentially(due.map((correction) => ({
    ...correction,
    syncStatus: 'sync_queued',
    error: null,
  })));
}
