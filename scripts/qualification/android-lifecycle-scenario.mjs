import { createHash } from 'node:crypto';

import {
  classifyRecoveryDurability,
  classifySavedDetailDurability,
  observeHomeSurface,
  observeRecordingSurface,
  optionalUniqueAction,
  optionalUniqueMarker,
  parsePublicRecordingCount,
  readUniqueMarkerLabel,
  readUniqueMarkerToken,
  requireNoActiveRecordingSurface,
  requireOneNewRecording,
  requireTimerAdvance,
  requireTimerHeld,
  requireUniqueAction,
  selectTopMeetingCard,
} from './android-lifecycle-core.mjs';

const MAX_FIRST_RESUME_ACCEPTED_MS = 5_000;
const QUALIFICATION_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AndroidLifecycleQualificationFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'AndroidLifecycleQualificationFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new AndroidLifecycleQualificationFailure(code);
}

function fixedCode(value) {
  return value.replace(/[^a-z0-9]+/gu, '_').replace(/^_|_$/gu, '').toUpperCase();
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function deriveQualificationRecordingRunId(attemptRunId, recordingSlot) {
  if (typeof attemptRunId !== 'string' || !QUALIFICATION_RUN_ID.test(attemptRunId)
    || !['normal', 'recovery'].includes(recordingSlot)) {
    fail('QUALIFICATION_RUN_ID_INVALID');
  }
  const hex = createHash('sha256')
    .update(`maina-android-lifecycle-qualification-v1\0${attemptRunId.toLowerCase()}\0${recordingSlot}`, 'utf8')
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deriveQualificationEvidenceDigest(runId) {
  if (typeof runId !== 'string' || !QUALIFICATION_RUN_ID.test(runId)) fail('QUALIFICATION_RUN_ID_INVALID');
  return createHash('sha256')
    .update(`maina-android-qualification-evidence-v1\0${runId.toLowerCase()}`, 'utf8')
    .digest('hex');
}

async function stage(code, callback) {
  try {
    return await callback();
  } catch (error) {
    if (error instanceof AndroidLifecycleQualificationFailure) throw error;
    fail(code);
  }
}

async function poll(code, tools, callback, timeoutMs, intervalMs = 200) {
  const started = tools.now();
  while (tools.now() - started <= timeoutMs) {
    const value = await callback();
    if (value !== null && value !== false) return value;
    await tools.sleep(intervalMs);
  }
  fail(code);
}

async function waitNotification(tools, expected, timeoutMs = 20_000) {
  return poll(`NOTIFICATION_${expected.toUpperCase()}_TIMEOUT`, tools, async () => {
    const observed = await stage('NOTIFICATION_OBSERVATION_FAILED', () => tools.notificationState());
    return observed === expected ? expected : null;
  }, timeoutMs);
}

async function waitRecordingSurface(tools, expected, timeoutMs = 15_000) {
  return poll(`RECORDING_${expected.toUpperCase()}_SURFACE_TIMEOUT`, tools, async () => {
    const nodes = await stage('UI_OBSERVATION_FAILED', () => tools.readUiNodes());
    const surface = await stage('RECORDING_SURFACE_INVALID', () => observeRecordingSurface(nodes));
    return surface?.state === expected ? Object.freeze({ ...surface, nodes }) : null;
  }, timeoutMs);
}

async function waitHome(tools, timeoutMs = 15_000) {
  return poll('HOME_SURFACE_TIMEOUT', tools, async () => {
    const nodes = await stage('UI_OBSERVATION_FAILED', () => tools.readUiNodes());
    const home = await stage('HOME_SURFACE_INVALID', () => observeHomeSurface(nodes));
    return home ? { nodes, record: home.record } : null;
  }, timeoutMs);
}

async function waitSavedDetail(tools, timeoutMs = 20_000) {
  return poll('SAVED_DETAIL_TIMEOUT', tools, async () => {
    const nodes = await stage('UI_OBSERVATION_FAILED', () => tools.readUiNodes());
    const marker = await stage('SAVED_DETAIL_AMBIGUOUS', () => optionalUniqueAction(nodes, {
      label: 'Delete meeting',
      testId: 'meeting-detail-delete',
    }));
    if (!marker) return null;
    try {
      return {
        nodes,
        privateCorrelationToken: readUniqueMarkerToken(nodes, 'meeting-detail-correlation-'),
        privateMetadata: readUniqueMarkerLabel(nodes, 'meeting-detail-metadata'),
      };
    } catch {
      return null;
    }
  }, timeoutMs);
}

async function waitRecoveredRoute(tools, privateCorrelationToken, privateMetadata, timeoutMs = 30_000) {
  return poll('RECOVERED_DETAIL_TIMEOUT', tools, async () => {
    const nodes = await stage('UI_OBSERVATION_FAILED', () => tools.readUiNodes());
    const recovery = await stage('RECOVERY_DETAIL_AMBIGUOUS', () => optionalUniqueMarker(nodes, 'meeting-recovery-root'));
    const detail = await stage('SAVED_DETAIL_AMBIGUOUS', () => optionalUniqueAction(nodes, {
      label: 'Delete meeting',
      testId: 'meeting-detail-delete',
    }));
    if (recovery && detail) fail('RECOVERED_DETAIL_ROUTE_AMBIGUOUS');
    if (!recovery && !detail) return null;
    try {
      const metadata = readUniqueMarkerLabel(nodes, recovery ? 'meeting-recovery-metadata' : 'meeting-detail-metadata');
      const correlationToken = readUniqueMarkerToken(
        nodes,
        recovery ? 'meeting-recovery-correlation-' : 'meeting-detail-correlation-',
      );
      if (metadata !== privateMetadata) fail('RECOVERED_DETAIL_IDENTITY_MISMATCH');
      if (correlationToken !== privateCorrelationToken) fail('RECOVERED_DETAIL_IDENTITY_MISMATCH');
      requireNoActiveRecordingSurface(nodes);
      if (recovery) {
        return { route: 'recovery', durability: classifyRecoveryDurability(nodes), nodes };
      }
      return { route: 'detail', durability: null, nodes };
    } catch (error) {
      if (error instanceof AndroidLifecycleQualificationFailure) throw error;
      return null;
    }
  }, timeoutMs);
}

async function waitSavedDetailDurability(tools, privateCorrelationToken, privateMetadata, timeoutMs = 30_000) {
  return poll('SAVED_DETAIL_DURABILITY_TIMEOUT', tools, async () => {
    const nodes = await stage('UI_OBSERVATION_FAILED', () => tools.readUiNodes());
    try {
      if (readUniqueMarkerLabel(nodes, 'meeting-detail-metadata') !== privateMetadata) {
        fail('RECOVERED_DETAIL_IDENTITY_MISMATCH');
      }
      if (readUniqueMarkerToken(nodes, 'meeting-detail-correlation-') !== privateCorrelationToken) {
        fail('RECOVERED_DETAIL_IDENTITY_MISMATCH');
      }
      requireNoActiveRecordingSurface(nodes);
      return classifySavedDetailDurability(nodes);
    } catch (error) {
      if (error instanceof AndroidLifecycleQualificationFailure) throw error;
      return null;
    }
  }, timeoutMs);
}

function validateMutationReceipt(receipt, code) {
  if (!exactKeys(receipt, ['spawned', 'exitCode', 'signal', 'timedOut'])
    || typeof receipt.spawned !== 'boolean'
    || (receipt.exitCode !== null && (!Number.isSafeInteger(receipt.exitCode) || receipt.exitCode < 0 || receipt.exitCode > 255))
    || (receipt.signal !== null && (typeof receipt.signal !== 'string' || !/^[A-Z0-9]+$/u.test(receipt.signal)))
    || typeof receipt.timedOut !== 'boolean') {
    fail(`${code}_RECEIPT_INVALID`);
  }
  return receipt;
}

function newMutationLedger(tools, operational) {
  const entries = [];
  const byId = new Map();
  const record = async (entry) => {
    if (typeof tools.recordMutationState !== 'function') {
      if (operational) fail('DURABLE_MUTATION_JOURNAL_UNAVAILABLE');
      return;
    }
    try {
      await tools.recordMutationState(Object.freeze({ ...entry }));
    } catch {
      fail('DURABLE_MUTATION_JOURNAL_FAILED');
    }
  };
  return {
    entries,
    async issue(id, tools, action, payload, postcondition) {
      const code = fixedCode(id);
      if (byId.has(id)) fail('MUTATION_REPLAY_REJECTED');
      const payloadShape = Object.keys(payload).sort();
      const payloadDigest = ['arm_qualification', 'launch_record_qualification', 'pause_qualification'].includes(action)
        ? deriveQualificationEvidenceDigest(payload.qualificationRunId)
        : null;
      const entry = { id, action, payloadDigest, payloadShape, state: 'issued', attempts: 1 };
      entries.push(entry);
      byId.set(id, entry);
      await record(entry);
      let receipt;
      try {
        receipt = validateMutationReceipt(await tools.performMutation({ id, action, payload }), code);
      } catch (error) {
        entry.state = 'ambiguous';
        await record(entry);
        if (error instanceof AndroidLifecycleQualificationFailure) throw error;
        fail(`${code}_AMBIGUOUS`);
      }
      if (!receipt.spawned) {
        entry.state = 'confirmed_no_effect';
        await record(entry);
        fail(`${code}_NOT_SPAWNED`);
      }
      if (receipt.exitCode !== 0 || receipt.signal !== null || receipt.timedOut) {
        entry.state = 'ambiguous';
        await record(entry);
        fail(`${code}_AMBIGUOUS`);
      }
      try {
        const value = await postcondition();
        entry.state = 'confirmed_applied';
        await record(entry);
        return value;
      } catch (error) {
        entry.state = 'ambiguous';
        await record(entry);
        throw error;
      }
    },
    reconcileOutstanding() {
      for (const entry of entries) if (entry.state === 'issued') entry.state = 'ambiguous';
    },
  };
}

function validateProgress(value, expectedQualificationEvidenceDigest) {
  if (!exactKeys(value, [
    'active', 'bytesWritten', 'chunkIndex', 'clean', 'lastProgressAtMs', 'nativeState', 'notificationState', 'presentationState',
    'qualificationEvidenceDigest', 'qualificationSession',
  ])
    || !['idle', 'ownership_pending', 'paused', 'recording', 'error'].includes(value.nativeState)
    || !['ready', 'recording', 'paused', 'saving'].includes(value.presentationState)
    || value.notificationState !== value.presentationState
    || typeof value.clean !== 'boolean'
    || typeof value.active !== 'boolean'
    || !Number.isSafeInteger(value.chunkIndex) || value.chunkIndex < 0
    || !Number.isSafeInteger(value.bytesWritten) || value.bytesWritten < 0
    || !Number.isSafeInteger(value.lastProgressAtMs) || value.lastProgressAtMs < 0
    || typeof value.qualificationSession !== 'boolean'
    || (value.qualificationEvidenceDigest !== null
      && (typeof value.qualificationEvidenceDigest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(value.qualificationEvidenceDigest)))
    || value.qualificationSession !== (expectedQualificationEvidenceDigest !== null)
    || value.qualificationEvidenceDigest !== expectedQualificationEvidenceDigest) {
    fail('NATIVE_PROGRESS_INVALID');
  }
  return value;
}

async function readProgress(tools, expectedQualificationEvidenceDigest) {
  return stage('NATIVE_PROGRESS_OBSERVATION_FAILED', async () => validateProgress(
    await tools.nativeCaptureProgress(),
    expectedQualificationEvidenceDigest,
  ));
}

async function waitOwnedRecording(tools, expectedQualificationEvidenceDigest, timeoutMs = 20_000) {
  await waitNotification(tools, 'recording', timeoutMs);
  return poll('QUALIFICATION_OWNERSHIP_UNPROVEN', tools, async () => {
    const progress = await readProgress(tools, expectedQualificationEvidenceDigest);
    return progress.clean && progress.active && progress.nativeState === 'recording' ? progress : null;
  }, timeoutMs);
}

function requireProgressAdvance(before, after, code) {
  const sameChunkAdvanced = after.chunkIndex === before.chunkIndex && after.bytesWritten > before.bytesWritten;
  const laterChunkAdvanced = after.chunkIndex > before.chunkIndex;
  if (!before.clean || !after.clean
    || before.nativeState !== 'recording' || after.nativeState !== 'recording'
    || !before.active || !after.active
    || (!sameChunkAdvanced && !laterChunkAdvanced)
    || after.lastProgressAtMs <= before.lastProgressAtMs) fail(code);
}

function requireProgressHeld(before, after, code) {
  if (!before.clean || !after.clean
    || before.nativeState !== 'paused' || after.nativeState !== 'paused'
    || before.active || after.active
    || after.chunkIndex !== before.chunkIndex
    || after.bytesWritten !== before.bytesWritten
    || after.lastProgressAtMs !== before.lastProgressAtMs) fail(code);
}

async function launchHome(tools, ledger, id) {
  return ledger.issue(id, tools, 'launch_home', {}, async () => waitHome(tools, 20_000));
}

async function startRecording(tools, ledger, home, id, recordingSlot) {
  if (!home.record || typeof home.record.x !== 'number') fail('QUALIFICATION_RECORD_LAUNCH_INVALID');
  const qualificationRunId = deriveQualificationRecordingRunId(tools.qualificationRunId, recordingSlot);
  const qualificationEvidenceDigest = deriveQualificationEvidenceDigest(qualificationRunId);
  await ledger.issue(`${id}-arm`, tools, 'arm_qualification', {
    qualificationRunId,
  }, async () => true);
  return ledger.issue(id, tools, 'launch_record_qualification', {
    qualificationRunId,
  }, async () => {
    const progress = await waitOwnedRecording(tools, qualificationEvidenceDigest, 20_000);
    return Object.freeze({ progress, qualificationRunId, qualificationEvidenceDigest });
  });
}

async function pauseForStableUi(tools, ledger, id, qualificationRunId, qualificationEvidenceDigest) {
  return ledger.issue(id, tools, 'pause_qualification', { qualificationRunId }, async () => {
    await waitNotification(tools, 'paused', 15_000);
    const surface = await waitRecordingSurface(tools, 'paused', 15_000);
    const progress = await readProgress(tools, qualificationEvidenceDigest);
    if (!progress.clean || progress.active || progress.nativeState !== 'paused') fail('QUALIFICATION_PAUSE_UNPROVEN');
    return Object.freeze({ surface, progress });
  });
}

function newMeasurements() {
  return {
    firstTimerSeconds: null,
    secondTimerSeconds: null,
    timerAdvanceSeconds: null,
    firstResumeAcceptedMs: null,
    pausedTimerSeconds: null,
    pausedTimerAfterHoldSeconds: null,
    backgroundTimerAdvanceSeconds: null,
    screenOffTimerAdvanceSeconds: null,
    backgroundNativeProgressAdvanced: false,
    screenOffNativeProgressAdvanced: false,
    beforeNormalSaveCount: null,
    afterNormalSaveCount: null,
    afterIdleRestartCount: null,
    beforeRecoveryCount: null,
    afterRecoveryCount: null,
    recoveredVisibleCardCount: null,
    recoveryCorrelation: null,
    recoveredAudioAvailable: null,
    recoveredPositiveSegments: null,
    recoveredRetranscribe: null,
    pausedNativeProgressHeld: false,
    normalSaveNativeInactive: false,
    powerOffObserved: false,
    powerOnObserved: false,
    syntheticMeetingsRetained: 0,
  };
}

export async function executeAndroidLifecycleScenario(config, tools) {
  const tests = [];
  const measurements = newMeasurements();
  const operational = config.operational === true;
  const ledger = newMutationLedger(tools, operational);
  const pass = (id) => tests.push({ id, status: 'PASS' });
  let captureMayBeActive = false;
  let powerMayBeOff = false;

  try {
    if (config.localMeetingCreatorExclusive !== true) fail('LOCAL_MEETING_CREATOR_EXCLUSIVITY_UNPROVEN');
    if (config.meetingListNewestFirst !== true) fail('MEETING_LIST_ORDER_UNPROVEN');
    if (typeof tools.qualificationRunId !== 'string'
      || !QUALIFICATION_RUN_ID.test(tools.qualificationRunId)) {
      fail('QUALIFICATION_RUN_ID_INVALID');
    }
    const identity = await stage('INSTALLED_IDENTITY_UNAVAILABLE', () => tools.installedIdentity());
    if (identity.version !== config.expectedVersion || identity.build !== config.expectedBuild) fail('INSTALLED_IDENTITY_MISMATCH');
    pass('exact_installed_identity');
    const installedArtifactSha256 = await stage('INSTALLED_ARTIFACT_UNAVAILABLE', () => tools.installedArtifactSha256());
    if (typeof config.expectedArtifactSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(config.expectedArtifactSha256)
      || installedArtifactSha256 !== config.expectedArtifactSha256) fail('INSTALLED_ARTIFACT_MISMATCH');
    pass('exact_installed_artifact');

    await waitNotification(tools, 'ready');
    const initialProgress = await readProgress(tools, null);
    if (initialProgress.active || !initialProgress.clean || initialProgress.nativeState !== 'idle') {
      fail('INITIAL_NATIVE_CAPTURE_NOT_IDLE');
    }
    await ledger.issue('force-stop-initial-idle', tools, 'force_stop', {}, async () => (
      await stage('PROCESS_OBSERVATION_FAILED', () => tools.processState()) === 'absent' ? true : fail('INITIAL_FORCE_STOP_UNPROVEN')
    ));
    const initialHome = await launchHome(tools, ledger, 'launch-initial-home');
    await waitNotification(tools, 'ready');
    measurements.beforeNormalSaveCount = parsePublicRecordingCount(initialHome.nodes);
    pass('launch_home_ready');

    const normalQualificationRunId = deriveQualificationRecordingRunId(tools.qualificationRunId, 'normal');
    const normalQualificationEvidenceDigest = deriveQualificationEvidenceDigest(normalQualificationRunId);
    const normalStart = await startRecording(tools, ledger, initialHome, 'launch-start-normal', 'normal');
    captureMayBeActive = true;
    const initialPaused = await pauseForStableUi(
      tools,
      ledger,
      'pause-normal-for-initial-ui',
      normalStart.qualificationRunId,
      normalStart.qualificationEvidenceDigest,
    );
    measurements.firstTimerSeconds = initialPaused.surface.timerSeconds;
    const stopCoordinate = await stage('STOP_ACTION_UNAVAILABLE', () => requireUniqueAction(
      initialPaused.surface.nodes,
      { label: 'Stop and save', testId: 'recording-stop-save' },
    ));
    const pauseResumeCoordinate = await stage('RESUME_ACTION_UNAVAILABLE', () => requireUniqueAction(
      initialPaused.surface.nodes,
      { label: 'Resume', testId: 'recording-pause-resume' },
    ));
    const resumeVisibleAt = tools.now();
    const resumedProgress = await ledger.issue('tap-resume-first', tools, 'tap', pauseResumeCoordinate, async () => (
      waitOwnedRecording(tools, normalStart.qualificationEvidenceDigest, 20_000)
    ));
    measurements.firstResumeAcceptedMs = tools.now() - resumeVisibleAt;
    if (measurements.firstResumeAcceptedMs > MAX_FIRST_RESUME_ACCEPTED_MS) fail('FIRST_RESUME_ACCEPTANCE_TOO_SLOW');
    await tools.sleep(3_000);
    const advancedProgress = await readProgress(tools, normalStart.qualificationEvidenceDigest);
    requireProgressAdvance(resumedProgress, advancedProgress, 'RECORDING_NATIVE_PROGRESS_STALLED');
    const paused = await ledger.issue('tap-pause-hold', tools, 'tap', pauseResumeCoordinate, async () => {
      await waitNotification(tools, 'paused', 15_000);
      return waitRecordingSurface(tools, 'paused', 15_000);
    });
    measurements.secondTimerSeconds = paused.timerSeconds;
    measurements.timerAdvanceSeconds = await stage('RECORDING_TIMER_STALLED', () => requireTimerAdvance(
      measurements.firstTimerSeconds, measurements.secondTimerSeconds, 2,
    ));
    pass('recording_start_and_timer_advanced');
    pass('first_visible_resume_tap');

    measurements.pausedTimerSeconds = paused.timerSeconds;
    const pausedProgressBefore = await readProgress(tools, normalQualificationEvidenceDigest);
    await tools.sleep(4_000);
    const pausedAfterHold = await waitRecordingSurface(tools, 'paused', 5_000);
    measurements.pausedTimerAfterHoldSeconds = pausedAfterHold.timerSeconds;
    await stage('PAUSED_TIMER_ADVANCED', () => requireTimerHeld(measurements.pausedTimerSeconds, measurements.pausedTimerAfterHoldSeconds));
    const pausedProgressAfter = await readProgress(tools, normalQualificationEvidenceDigest);
    requireProgressHeld(pausedProgressBefore, pausedProgressAfter, 'PAUSED_NATIVE_PROGRESS_ADVANCED');
    measurements.pausedNativeProgressHeld = true;
    const resumeHold = await stage('RESUME_ACTION_UNAVAILABLE', () => requireUniqueAction(
      pausedAfterHold.nodes,
      { label: 'Resume', testId: 'recording-pause-resume' },
    ));
    await ledger.issue('tap-resume-hold', tools, 'tap', resumeHold, async () => {
      return waitOwnedRecording(tools, normalQualificationEvidenceDigest, 20_000);
    });
    pass('paused_state_holds_and_manual_resume');

    const backgroundTimerBefore = pausedAfterHold.timerSeconds;
    const backgroundProgressBefore = await readProgress(tools, normalQualificationEvidenceDigest);
    await ledger.issue('press-home-during-recording', tools, 'press_home', {}, async () => (
      await stage('FOREGROUND_OBSERVATION_FAILED', () => tools.foregroundState()) === 'background' ? true : fail('BACKGROUND_STATE_UNPROVEN')
    ));
    await tools.sleep(8_000);
    await waitNotification(tools, 'recording', 5_000);
    const backgroundProgressAfter = await readProgress(tools, normalQualificationEvidenceDigest);
    requireProgressAdvance(backgroundProgressBefore, backgroundProgressAfter, 'BACKGROUND_NATIVE_PROGRESS_STALLED');
    measurements.backgroundNativeProgressAdvanced = true;
    await ledger.issue('launch-after-background', tools, 'launch_main', {}, async () => {
      if (await stage('FOREGROUND_OBSERVATION_FAILED', () => tools.foregroundState()) !== 'foreground') fail('FOREGROUND_STATE_UNPROVEN');
      return waitOwnedRecording(tools, normalQualificationEvidenceDigest, 20_000);
    });
    const backgroundPaused = await ledger.issue('tap-pause-after-background', tools, 'tap', pauseResumeCoordinate, async () => {
      await waitNotification(tools, 'paused', 15_000);
      return waitRecordingSurface(tools, 'paused', 15_000);
    });
    measurements.backgroundTimerAdvanceSeconds = await stage('BACKGROUND_TIMER_STALLED', () => requireTimerAdvance(
      backgroundTimerBefore,
      backgroundPaused.timerSeconds,
      6,
    ));
    const backgroundResume = await stage('RESUME_ACTION_UNAVAILABLE', () => requireUniqueAction(
      backgroundPaused.nodes,
      { label: 'Resume', testId: 'recording-pause-resume' },
    ));
    await ledger.issue('tap-resume-after-background', tools, 'tap', backgroundResume, async () => (
      waitOwnedRecording(tools, normalQualificationEvidenceDigest, 20_000)
    ));
    pass('background_foreground_recording');

    if (await stage('POWER_OBSERVATION_FAILED', () => tools.powerState()) !== 'on') fail('POWER_PRECONDITION_INVALID');
    const screenOffTimerBefore = backgroundPaused.timerSeconds;
    const screenOffProgressBefore = await readProgress(tools, normalQualificationEvidenceDigest);
    await ledger.issue('sleep-screen-during-recording', tools, 'sleep_device', {}, async () => poll('POWER_OFF_UNPROVEN', tools, async () => (
      await stage('POWER_OBSERVATION_FAILED', () => tools.powerState()) === 'off'
    ), 8_000));
    measurements.powerOffObserved = true;
    powerMayBeOff = true;
    await tools.sleep(8_000);
    await waitNotification(tools, 'recording', 5_000);
    const screenOffProgressAfter = await readProgress(tools, normalQualificationEvidenceDigest);
    requireProgressAdvance(screenOffProgressBefore, screenOffProgressAfter, 'SCREEN_OFF_NATIVE_PROGRESS_STALLED');
    measurements.screenOffNativeProgressAdvanced = true;
    await ledger.issue('wake-screen-after-recording', tools, 'wake_up', {}, async () => poll('POWER_ON_UNPROVEN', tools, async () => (
      await stage('POWER_OBSERVATION_FAILED', () => tools.powerState()) === 'on'
    ), 8_000));
    measurements.powerOnObserved = true;
    powerMayBeOff = false;
    await ledger.issue('launch-after-screen-wake', tools, 'launch_main', {}, async () => {
      if (await stage('FOREGROUND_OBSERVATION_FAILED', () => tools.foregroundState()) !== 'foreground') fail('FOREGROUND_STATE_UNPROVEN');
      return waitOwnedRecording(tools, normalQualificationEvidenceDigest, 20_000);
    });
    const screenOnPaused = await ledger.issue('tap-pause-after-screen-wake', tools, 'tap', pauseResumeCoordinate, async () => {
      await waitNotification(tools, 'paused', 15_000);
      return waitRecordingSurface(tools, 'paused', 15_000);
    });
    measurements.screenOffTimerAdvanceSeconds = await stage('SCREEN_OFF_TIMER_STALLED', () => requireTimerAdvance(
      screenOffTimerBefore,
      screenOnPaused.timerSeconds,
      6,
    ));
    const screenOnResume = await stage('RESUME_ACTION_UNAVAILABLE', () => requireUniqueAction(
      screenOnPaused.nodes,
      { label: 'Resume', testId: 'recording-pause-resume' },
    ));
    await ledger.issue('tap-resume-after-screen-wake', tools, 'tap', screenOnResume, async () => (
      waitOwnedRecording(tools, normalQualificationEvidenceDigest, 20_000)
    ));
    pass('screen_off_on_recording');

    const savedDetail = await ledger.issue('tap-stop-normal', tools, 'tap', stopCoordinate, async () => {
      await waitNotification(tools, 'ready', 90_000);
      const detail = await waitSavedDetail(tools, 30_000);
      const stoppedProgress = await readProgress(tools, null);
      if (stoppedProgress.active || !stoppedProgress.clean || stoppedProgress.nativeState !== 'idle') {
        fail('NORMAL_SAVE_NATIVE_CAPTURE_ACTIVE');
      }
      measurements.normalSaveNativeInactive = true;
      return detail;
    });
    captureMayBeActive = false;
    const savedHome = await ledger.issue('back-from-saved-detail', tools, 'press_back', {}, async () => waitHome(tools, 15_000));
    measurements.afterNormalSaveCount = parsePublicRecordingCount(savedHome.nodes);
    requireOneNewRecording(measurements.beforeNormalSaveCount, measurements.afterNormalSaveCount);
    const savedTopCard = await stage('NORMAL_SAVE_CARD_CORRELATION_FAILED', () => selectTopMeetingCard(savedHome.nodes));
    if (savedTopCard.privateMetadata !== savedDetail.privateMetadata
      || savedTopCard.privateCorrelationToken !== savedDetail.privateCorrelationToken) {
      fail('NORMAL_SAVE_CARD_IDENTITY_MISMATCH');
    }
    measurements.syntheticMeetingsRetained += 1;
    pass('stop_save_opens_exact_detail_and_adds_one');

    await ledger.issue('force-stop-idle', tools, 'force_stop', {}, async () => (
      await stage('PROCESS_OBSERVATION_FAILED', () => tools.processState()) === 'absent' ? true : fail('IDLE_FORCE_STOP_UNPROVEN')
    ));
    captureMayBeActive = false;
    const restartedHome = await launchHome(tools, ledger, 'launch-after-idle-force-stop');
    await waitNotification(tools, 'ready', 20_000);
    measurements.afterIdleRestartCount = parsePublicRecordingCount(restartedHome.nodes);
    if (measurements.afterIdleRestartCount !== measurements.afterNormalSaveCount) fail('IDLE_RESTART_COUNT_DRIFT');
    pass('idle_process_restart_preserves_count');

    measurements.beforeRecoveryCount = measurements.afterIdleRestartCount;
    const recoveryStart = await startRecording(tools, ledger, restartedHome, 'launch-start-recovery', 'recovery');
    captureMayBeActive = true;
    await tools.sleep(3_000);
    const recoveryProgressAfter = await readProgress(tools, recoveryStart.qualificationEvidenceDigest);
    requireProgressAdvance(recoveryStart.progress, recoveryProgressAfter, 'RECOVERY_NATIVE_PROGRESS_STALLED');
    await ledger.issue('force-stop-active-recovery', tools, 'force_stop', {}, async () => (
      await stage('PROCESS_OBSERVATION_FAILED', () => tools.processState()) === 'absent' ? true : fail('RECOVERY_FORCE_STOP_UNPROVEN')
    ));
    captureMayBeActive = false;
    const recoveredHome = await launchHome(tools, ledger, 'launch-after-active-force-stop');
    await waitNotification(tools, 'ready', 30_000);
    measurements.afterRecoveryCount = parsePublicRecordingCount(recoveredHome.nodes);
    requireOneNewRecording(measurements.beforeRecoveryCount, measurements.afterRecoveryCount);
    const card = await stage('RECOVERY_CARD_CORRELATION_FAILED', () => selectTopMeetingCard(recoveredHome.nodes));
    measurements.recoveredVisibleCardCount = card.visibleCardCount;
    measurements.recoveryCorrelation = 'newest_first_count_delta_plus_exact_row_identity';
    const recoveredRoute = await ledger.issue(
      'tap-recovered-top-card',
      tools,
      'tap',
      Object.freeze({ x: card.x, y: card.y }),
      async () => waitRecoveredRoute(tools, card.privateCorrelationToken, card.privateMetadata, 30_000),
    );
    let durability = recoveredRoute.durability;
    if (recoveredRoute.route === 'detail') {
      const transcript = await stage('RECOVERED_TRANSCRIPT_ACTION_UNAVAILABLE', () => requireUniqueAction(
        recoveredRoute.nodes,
        { label: 'Transcript', testId: 'meeting-tab-transcript' },
      ));
      durability = await ledger.issue(
        'tap-recovered-transcript',
        tools,
        'tap',
        transcript,
        async () => waitSavedDetailDurability(tools, card.privateCorrelationToken, card.privateMetadata, 30_000),
      );
    }
    if (!durability) fail('PROCESS_DEATH_DURABILITY_UNPROVEN');
    measurements.recoveredAudioAvailable = durability.audioAvailable;
    measurements.recoveredPositiveSegments = durability.positiveSegments;
    measurements.recoveredRetranscribe = durability.retranscribe;
    measurements.syntheticMeetingsRetained += 1;
    pass('recording_process_death_recovery');

    return {
      status: 'passed',
      reasonCode: null,
      tests,
      measurements,
      mutations: ledger.entries,
      cleanup: 'synthetic_rows_retained',
      reconciliationRequired: false,
    };
  } catch (error) {
    ledger.reconcileOutstanding();
    return {
      status: 'failed_closed',
      reasonCode: error instanceof AndroidLifecycleQualificationFailure ? error.code : 'ANDROID_LIFECYCLE_QUALIFICATION_FAILED',
      tests,
      measurements,
      mutations: ledger.entries,
      cleanup: 'no_automatic_mutation_after_failure',
      reconciliationRequired: captureMayBeActive
        || powerMayBeOff
        || ledger.entries.some((entry) => entry.state === 'ambiguous'),
    };
  }
}

export const androidLifecycleScenarioPolicy = Object.freeze({
  schemaVersion: 'maina.android-lifecycle-scenario.v2',
  physicalIncomingCallTestPerformed: false,
  rawScreenshotsAllowed: false,
  rawHierarchyPersistenceAllowed: false,
  allowedMutations: Object.freeze(['arm_qualification', 'force_stop', 'launch_home', 'launch_main', 'launch_record_qualification', 'pause_qualification', 'press_back', 'press_home', 'sleep_device', 'tap', 'wake_up']),
  expectedTestIds: Object.freeze([
    'exact_installed_identity',
    'exact_installed_artifact',
    'launch_home_ready',
    'recording_start_and_timer_advanced',
    'first_visible_resume_tap',
    'paused_state_holds_and_manual_resume',
    'background_foreground_recording',
    'screen_off_on_recording',
    'stop_save_opens_exact_detail_and_adds_one',
    'idle_process_restart_preserves_count',
    'recording_process_death_recovery',
  ]),
  maxFirstResumeAcceptedMs: MAX_FIRST_RESUME_ACCEPTED_MS,
  passedMutationTraces: Object.freeze([
    Object.freeze([
      ['force-stop-initial-idle', 'force_stop', []],
      ['launch-initial-home', 'launch_home', []],
      ['launch-start-normal-arm', 'arm_qualification', ['qualificationRunId']],
      ['launch-start-normal', 'launch_record_qualification', ['qualificationRunId']],
      ['pause-normal-for-initial-ui', 'pause_qualification', ['qualificationRunId']],
      ['tap-resume-first', 'tap', ['x', 'y']],
      ['tap-pause-hold', 'tap', ['x', 'y']],
      ['tap-resume-hold', 'tap', ['x', 'y']],
      ['press-home-during-recording', 'press_home', []],
      ['launch-after-background', 'launch_main', []],
      ['tap-pause-after-background', 'tap', ['x', 'y']],
      ['tap-resume-after-background', 'tap', ['x', 'y']],
      ['sleep-screen-during-recording', 'sleep_device', []],
      ['wake-screen-after-recording', 'wake_up', []],
      ['launch-after-screen-wake', 'launch_main', []],
      ['tap-pause-after-screen-wake', 'tap', ['x', 'y']],
      ['tap-resume-after-screen-wake', 'tap', ['x', 'y']],
      ['tap-stop-normal', 'tap', ['x', 'y']],
      ['back-from-saved-detail', 'press_back', []],
      ['force-stop-idle', 'force_stop', []],
      ['launch-after-idle-force-stop', 'launch_home', []],
      ['launch-start-recovery-arm', 'arm_qualification', ['qualificationRunId']],
      ['launch-start-recovery', 'launch_record_qualification', ['qualificationRunId']],
      ['force-stop-active-recovery', 'force_stop', []],
      ['launch-after-active-force-stop', 'launch_home', []],
      ['tap-recovered-top-card', 'tap', ['x', 'y']],
    ]),
    Object.freeze([
      ['force-stop-initial-idle', 'force_stop', []],
      ['launch-initial-home', 'launch_home', []],
      ['launch-start-normal-arm', 'arm_qualification', ['qualificationRunId']],
      ['launch-start-normal', 'launch_record_qualification', ['qualificationRunId']],
      ['pause-normal-for-initial-ui', 'pause_qualification', ['qualificationRunId']],
      ['tap-resume-first', 'tap', ['x', 'y']],
      ['tap-pause-hold', 'tap', ['x', 'y']],
      ['tap-resume-hold', 'tap', ['x', 'y']],
      ['press-home-during-recording', 'press_home', []],
      ['launch-after-background', 'launch_main', []],
      ['tap-pause-after-background', 'tap', ['x', 'y']],
      ['tap-resume-after-background', 'tap', ['x', 'y']],
      ['sleep-screen-during-recording', 'sleep_device', []],
      ['wake-screen-after-recording', 'wake_up', []],
      ['launch-after-screen-wake', 'launch_main', []],
      ['tap-pause-after-screen-wake', 'tap', ['x', 'y']],
      ['tap-resume-after-screen-wake', 'tap', ['x', 'y']],
      ['tap-stop-normal', 'tap', ['x', 'y']],
      ['back-from-saved-detail', 'press_back', []],
      ['force-stop-idle', 'force_stop', []],
      ['launch-after-idle-force-stop', 'launch_home', []],
      ['launch-start-recovery-arm', 'arm_qualification', ['qualificationRunId']],
      ['launch-start-recovery', 'launch_record_qualification', ['qualificationRunId']],
      ['force-stop-active-recovery', 'force_stop', []],
      ['launch-after-active-force-stop', 'launch_home', []],
      ['tap-recovered-top-card', 'tap', ['x', 'y']],
      ['tap-recovered-transcript', 'tap', ['x', 'y']],
    ]),
  ]),
});
