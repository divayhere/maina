import {
  getKnowledgeCloudCorrection,
  getLatestKnowledgeCloudCorrection,
  getMeeting,
  insertKnowledgeCloudCorrection,
  listKnowledgeCloudCorrectionsEligibleForQueue,
  listKnowledgeCloudCorrectionsNeedingSync,
  listKnowledgeCloudCorrections,
  listMeetingKnowledgeCloudCorrectionsNeedingSync,
  updateKnowledgeCloudCorrection,
  type KnowledgeCloudCorrection,
} from '@/data/meetings';
import { getMainaKnowledgeCloudSettings } from '@/services/config';
import { log } from '@/services/logger';
import { clearMainaCloudSession } from '@/services/mainaCloudSession';
import {
  buildMainaKnowledgeCloudCorrectionPackage,
  packetCorrectionSnapshots,
  sourceFieldFingerprint,
  type MeetingPacketCorrectionValues,
} from './mainaKnowledgeCloudCorrectionsCore';
import {
  classifyMainaKnowledgeCloudResponse,
  normalizeMainaKnowledgeCloudBaseUrl,
} from './mainaKnowledgeCloudCore';

const inflight = new Map<string, Promise<void>>();

async function decodeResponseBody(response: Response) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

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

  await updateKnowledgeCloudCorrection(correctionKey, {
    syncStatus: 'syncing',
    lastAttemptAt: Date.now(),
    error: null,
  });

  try {
    const response = await fetch(
      `${normalizeMainaKnowledgeCloudBaseUrl(settings.baseUrl)}/v1/corrections`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.token}`,
          'Content-Type': 'application/json',
        },
        body: correction.payloadJson,
      },
    );
    const result = classifyMainaKnowledgeCloudResponse({
      status: response.status,
      body: await decodeResponseBody(response),
    });

    if (result.outcome === 'success') {
      await updateKnowledgeCloudCorrection(correctionKey, {
        syncStatus: 'sync_succeeded',
        canonicalSha256: result.canonicalSha256 ?? null,
        syncedAt: Date.now(),
        error: null,
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
    await updateKnowledgeCloudCorrection(correctionKey, {
      syncStatus,
      error: result.message,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await updateKnowledgeCloudCorrection(correctionKey, {
      syncStatus: 'sync_failed_retryable',
      error: message,
    });
    log.warn('maina-cloud-correction', 'meeting knowledge correction sync failed', {
      meetingId: correction.meetingId,
      correctionKey,
      err: message,
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
}): Promise<number> {
  const settings = await getMainaKnowledgeCloudSettings();
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.token.trim()) return 0;
  const corrections = await listKnowledgeCloudCorrectionsEligibleForQueue(options);
  for (const correction of corrections) {
    await updateKnowledgeCloudCorrection(correction.correctionKey, {
      syncStatus: 'sync_queued',
      error: null,
    });
  }
  return syncSequentially(corrections.map((correction) => ({
    ...correction,
    syncStatus: 'sync_queued',
    error: null,
  })));
}
