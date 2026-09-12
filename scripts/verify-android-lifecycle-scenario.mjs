#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUiAutomatorHierarchy } from './qualification/android-lifecycle-core.mjs';
import {
  androidLifecycleScenarioPolicy,
  deriveQualificationEvidenceDigest,
  deriveQualificationRecordingRunId,
  executeAndroidLifecycleScenario,
} from './qualification/android-lifecycle-scenario.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const syntheticArtifactSha256 = 'a'.repeat(64);

function xmlNode(attributes) {
  const values = {
    text: '',
    'resource-id': '',
    class: 'android.view.View',
    package: 'com.divay.maina',
    'content-desc': '',
    clickable: 'false',
    enabled: 'true',
    bounds: '[0,0][100,100]',
    'visible-to-user': 'true',
    ...attributes,
  };
  return `<node ${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
}

function nodes(...items) {
  return parseUiAutomatorHierarchy(`<hierarchy>${items.join('')}</hierarchy>`);
}

function action(text, id, top, attributes = {}) {
  return xmlNode({ text, 'resource-id': id, clickable: 'true', bounds: `[0,${top}][200,${top + 80}]`, ...attributes });
}

function successReceipt() {
  return { spawned: true, exitCode: 0, signal: null, timedOut: false };
}

class FakeDevice {
  constructor(overrides = {}) {
    this.qualificationRunId = '00000000-0000-4000-8000-000000000001';
    this.nowMs = 0;
    this.screen = 'home';
    this.capture = 'ready';
    this.timer = 0;
    this.recordingCount = 10;
    this.power = 'on';
    this.process = 'present';
    this.pendingRecovery = false;
    this.visibleCards = [{ key: 'existing-meeting', metadata: 'Sep 11 · 8:00 AM · 1:00', recovery: false }];
    this.pendingCard = null;
    this.nextCard = 1;
    this.bytesWritten = 0;
    this.lastProgressAtMs = 0;
    this.freezeTimer = false;
    this.freezeBackgroundTimer = false;
    this.freezeBackgroundProgress = false;
    this.freezeScreenOffTimer = false;
    this.freezeScreenOffProgress = false;
    this.progressWhilePaused = false;
    this.firstResumeDelayMs = 0;
    this.nativeActiveAfterStop = false;
    this.nativeErrorAfterStop = false;
    this.nativeErrorWhilePaused = false;
    this.nativeError = false;
    this.forceRecoveryRoute = false;
    this.detailMetadataMismatch = false;
    this.detailCorrelationMismatch = false;
    this.homeLoadDelayReads = 0;
    this.omitHomeLoadMarker = false;
    this.homeSelected = true;
    this.duplicateNotifications = false;
    this.durabilityDelayReads = 0;
    this.rollChunkOnProgress = false;
    this.virtualizeOldAfterRecovery = false;
    this.currentCard = null;
    this.transcriptSelected = false;
    this.forceNativeActive = false;
    this.duplicateResume = false;
    this.rejectUiReadsWhileRecording = false;
    this.omitDurability = false;
    this.countDriftByMutationId = {};
    this.faultHits = new Map();
    this.ambiguousMutationId = null;
    this.ambiguousMutationApplied = false;
    this.notSpawnedMutationId = null;
    this.invalidReceiptMutationId = null;
    this.mutationCalls = new Map();
    this.mutationStates = [];
    this.qualificationArmed = null;
    this.qualificationEvidenceDigest = null;
    this.qualificationUsed = new Set();
    Object.assign(this, overrides);
  }

  now = () => this.nowMs;

  recordMutationState = async (entry) => {
    this.mutationStates.push({ ...entry });
  };

  sleep = async (ms) => {
    this.nowMs += ms;
    if (this.capture === 'paused' && this.progressWhilePaused) {
      this.bytesWritten += ms * 32;
      this.lastProgressAtMs = this.nowMs;
      return;
    }
    if (this.capture !== 'recording') return;
    const timerFrozen = this.freezeTimer
      || (this.screen === 'background' && this.freezeBackgroundTimer)
      || (this.power === 'off' && this.freezeScreenOffTimer);
    if (!timerFrozen) this.timer += Math.floor(ms / 1000);
    const progressFrozen = (this.screen === 'background' && this.freezeBackgroundProgress)
      || (this.power === 'off' && this.freezeScreenOffProgress);
    if (!progressFrozen) {
      if (this.rollChunkOnProgress) {
        this.chunkIndex = (this.chunkIndex ?? 0) + 1;
        this.bytesWritten = ms * 32;
        this.rollChunkOnProgress = false;
      } else {
        this.bytesWritten += ms * 32;
      }
      this.lastProgressAtMs = this.nowMs;
    }
  };

  installedIdentity = async () => ({ version: this.version ?? '0.10.69', build: this.build ?? 95 });
  installedArtifactSha256 = async () => this.artifactSha256 ?? syntheticArtifactSha256;
  notificationState = async () => this.capture;
  powerState = async () => this.power;
  processState = async () => this.process;
  foregroundState = async () => this.screen === 'background' ? 'background' : 'foreground';
  nativeCaptureProgress = async () => ({
    active: this.forceNativeActive || this.capture === 'recording',
    nativeState: this.nativeError
      ? 'error'
      : this.capture === 'recording'
        ? 'recording'
        : this.capture === 'paused'
          ? 'paused'
          : 'idle',
    presentationState: this.capture,
    notificationState: this.capture,
    clean: !this.nativeError,
    chunkIndex: this.chunkIndex ?? 0,
    bytesWritten: this.bytesWritten,
    lastProgressAtMs: this.lastProgressAtMs,
    qualificationSession: this.qualificationEvidenceDigest !== null,
    qualificationEvidenceDigest: this.qualificationEvidenceDigest,
  });

  performMutation = async ({ id, action: mutation, payload }) => {
    this.mutationCalls.set(id, (this.mutationCalls.get(id) ?? 0) + 1);
    assert.deepEqual(
      Object.keys(payload).sort(),
      mutation === 'tap' ? ['x', 'y'] : ['arm_qualification', 'launch_record_qualification', 'pause_qualification'].includes(mutation) ? ['qualificationRunId'] : [],
    );
    if (id === this.notSpawnedMutationId) return { spawned: false, exitCode: null, signal: null, timedOut: false };
    if (id === this.invalidReceiptMutationId) return { ...successReceipt(), unexpected: true };
    if (id === this.ambiguousMutationId) {
      if (this.ambiguousMutationApplied) this.applyMutation(id, mutation, payload);
      return { spawned: true, exitCode: null, signal: 'SIGTERM', timedOut: true };
    }
    this.applyMutation(id, mutation, payload);
    return successReceipt();
  };

  applyMutation(id, mutation, payload) {
    if (mutation === 'arm_qualification') {
      assert.equal(this.qualificationArmed, null);
      assert.equal(this.qualificationUsed.has(payload.qualificationRunId), false);
      this.qualificationUsed.add(payload.qualificationRunId);
      this.qualificationArmed = payload.qualificationRunId;
      return;
    }
    if (mutation === 'launch_record_qualification') {
      assert.equal(payload.qualificationRunId, this.qualificationArmed);
      this.qualificationArmed = null;
      this.qualificationEvidenceDigest = deriveQualificationEvidenceDigest(payload.qualificationRunId);
      this.screen = 'record';
      this.capture = 'recording';
      this.timer = 0;
      this.bytesWritten = 1;
      this.lastProgressAtMs = this.nowMs;
      this.recordingCount += 1;
      this.pendingCard = { key: `synthetic-meeting-${this.nextCard}`, recovery: false };
      this.pendingCard.metadata = `Sep 11 · 8:${String(10 + this.nextCard).padStart(2, '0')} AM · 0:20`;
      this.nextCard += 1;
      return;
    }
    if (mutation === 'pause_qualification') {
      assert.equal(this.capture, 'recording');
      this.capture = 'paused';
      return;
    }
    if (mutation === 'launch_main') {
      this.process = 'present';
      if (this.pendingRecovery) {
        this.capture = 'ready';
        this.pendingRecovery = false;
        assert.ok(this.pendingCard);
        this.pendingCard.recovery = this.forceRecoveryRoute;
        this.pendingCard.recovered = true;
        this.visibleCards.unshift(this.pendingCard);
        if (this.virtualizeOldAfterRecovery && this.visibleCards.length > 1) this.visibleCards.pop();
        this.pendingCard = null;
        this.screen = 'home';
        this.qualificationEvidenceDigest = null;
      } else if (this.capture === 'recording' || this.capture === 'paused') {
        this.screen = 'record';
      } else if (this.capture === 'ready') {
        this.screen = 'home';
      } else {
        throw new Error('FAKE_UNKNOWN_CAPTURE_STATE');
      }
      if (Object.hasOwn(this.countDriftByMutationId, id)) {
        this.recordingCount += this.countDriftByMutationId[id];
        this.faultHits.set(id, (this.faultHits.get(id) ?? 0) + 1);
      }
      return;
    }
    if (mutation === 'press_home') {
      this.screen = 'background';
      return;
    }
    if (mutation === 'sleep_device') {
      this.power = 'off';
      return;
    }
    if (mutation === 'wake_up') {
      this.power = 'on';
      return;
    }
    if (mutation === 'press_back') {
      if (this.screen !== 'detail') throw new Error('FAKE_BACK_OUTSIDE_DETAIL');
      this.screen = 'home';
      this.currentCard = null;
      this.transcriptSelected = false;
      return;
    }
    if (mutation === 'force_stop') {
      if (this.capture === 'recording' || this.capture === 'paused') {
        this.pendingRecovery = true;
        this.capture = 'ready';
      }
      this.process = 'absent';
      this.screen = 'stopped';
      return;
    }
    if (mutation !== 'tap') throw new Error('FAKE_UNKNOWN_MUTATION');
    const { y } = payload;
    if (this.screen === 'record' && y === 540) {
      if (this.capture === 'recording') {
        this.capture = 'paused';
        if (this.nativeErrorWhilePaused) this.nativeError = true;
      }
      else if (this.capture === 'paused') {
        if (this.firstResumeDelayMs > 0) {
          this.nowMs += this.firstResumeDelayMs;
          this.firstResumeDelayMs = 0;
        }
        this.capture = 'recording';
      }
      else throw new Error('FAKE_CONTROL_STATE_INVALID');
      return;
    }
    if (this.screen === 'record' && y === 440) {
      this.capture = 'ready';
      this.qualificationEvidenceDigest = null;
      this.forceNativeActive = this.nativeActiveAfterStop;
      this.nativeError = this.nativeErrorAfterStop;
      this.screen = 'detail';
      assert.ok(this.pendingCard);
      this.currentCard = this.pendingCard;
      this.visibleCards.unshift(this.pendingCard);
      this.pendingCard = null;
      return;
    }
    if (this.screen === 'home' && y >= 340 && (y - 340) % 220 === 0) {
      const card = this.visibleCards[(y - 340) / 220];
      if (!card) throw new Error('FAKE_UNKNOWN_CARD');
      this.currentCard = card;
      this.transcriptSelected = false;
      this.screen = card.recovery ? 'recovery' : 'detail';
      return;
    }
    if (this.screen === 'detail' && y === 340) {
      this.transcriptSelected = true;
      return;
    }
    throw new Error('FAKE_UNEXPECTED_TAP');
  }

  readUiNodes = async () => {
    if (this.screen === 'background' || this.screen === 'stopped') throw new Error('NO_FOREGROUND_UI');
    if (this.screen === 'record' && this.capture === 'recording' && this.rejectUiReadsWhileRecording) {
      throw new Error('SYNTHETIC_UI_IDLE_TIMEOUT');
    }
    if (this.screen === 'home') {
      if (this.homeLoadDelayReads > 0) {
        this.homeLoadDelayReads -= 1;
        return nodes(action('Record a meeting', 'record-meeting', 1000));
      }
      return nodes(
        action('Home', 'main-tab-index', 900, { selected: this.homeSelected ? 'true' : 'false' }),
        action('Notifications', '', 10),
        ...(this.duplicateNotifications ? [action('Notifications', '', 100)] : []),
        action('Record a meeting', 'record-meeting', 1000),
        ...(this.omitHomeLoadMarker ? [] : [xmlNode({ 'resource-id': 'meeting-list-loaded' })]),
        xmlNode({ text: `${this.recordingCount} recordings`, 'resource-id': 'recording-count' }),
        ...this.visibleCards.flatMap((card, index) => {
          const top = 300 + index * 220;
          return [
            action('', 'meeting-card', top),
            xmlNode({ text: card.metadata, 'resource-id': 'meeting-card-metadata', bounds: `[10,${top + 10}][190,${top + 50}]` }),
            xmlNode({ 'resource-id': `meeting-card-correlation-${card.key}`, bounds: `[10,${top + 50}][190,${top + 70}]` }),
          ];
        }),
      );
    }
    if (this.screen === 'detail') {
      const metadata = this.detailMetadataMismatch && this.currentCard?.recovered
        ? 'Sep 11 · 7:00 AM · 0:10'
        : this.currentCard?.metadata;
      return nodes(
        action('Delete meeting', 'meeting-detail-delete', 100),
        xmlNode({ text: metadata ?? '', 'resource-id': 'meeting-detail-metadata' }),
        xmlNode({ 'resource-id': `meeting-detail-correlation-${this.detailCorrelationMismatch && this.currentCard?.recovered ? 'older-colliding-row' : this.currentCard?.key ?? ''}` }),
        action('Transcript', 'meeting-tab-transcript', 300),
        ...(this.transcriptSelected ? [xmlNode({ text: 'No transcript · audio kept', 'resource-id': 'meeting-detail-audio-state' })] : []),
      );
    }
    if (this.screen === 'recovery') {
      const delayDurability = this.durabilityDelayReads > 0;
      if (delayDurability) this.durabilityDelayReads -= 1;
      const durable = this.omitDurability || delayDurability ? [] : [
        xmlNode({ text: 'Saved audio segments: 1', 'resource-id': 'meeting-recovery-segments' }),
        xmlNode({ text: 'Audio available: Yes', 'resource-id': 'meeting-recovery-audio' }),
        action('Re-transcribe from saved audio', 'meeting-recovery-retranscribe', 500),
      ];
      return nodes(
        xmlNode({ 'resource-id': 'meeting-recovery-root' }),
        ...(this.currentCard && !delayDurability ? [xmlNode({
          text: this.detailMetadataMismatch && this.currentCard.recovered ? 'Sep 11 · 7:00 AM · 0:10' : this.currentCard.metadata,
          'resource-id': 'meeting-recovery-metadata',
        }), xmlNode({
          'resource-id': `meeting-recovery-correlation-${this.detailCorrelationMismatch && this.currentCard.recovered ? 'older-colliding-row' : this.currentCard.key}`,
        })] : []),
        ...durable,
        action('Open saved transcript', 'meeting-recovery-open-saved', 600),
      );
    }
    const state = this.capture === 'paused' ? 'Paused' : 'Recording';
    const control = this.capture === 'paused' ? 'Resume' : 'Pause';
    const visible = [
      xmlNode({ text: `0:${String(this.timer).padStart(2, '0')}`, 'resource-id': 'recording-timer' }),
      xmlNode({ text: state, 'resource-id': 'recording-state' }),
      action('Stop and save', 'recording-stop-save', 400),
      action(control, 'recording-pause-resume', 500),
      action('Discard this recording', 'recording-discard', 600),
    ];
    if (this.duplicateResume && control === 'Resume') visible.push(action('Resume', 'recording-pause-resume', 700));
    return nodes(...visible);
  };
}

const config = {
  expectedVersion: '0.10.69',
  expectedBuild: 95,
  localMeetingCreatorExclusive: true,
  meetingListNewestFirst: true,
  expectedArtifactSha256: syntheticArtifactSha256,
};
let cases = 0;

function assertAtMostOneMutation(device) {
  for (const attempts of device.mutationCalls.values()) assert.equal(attempts, 1);
  for (const id of device.mutationCalls.keys()) {
    const states = device.mutationStates.filter((entry) => entry.id === id).map(({ state }) => state);
    assert.equal(states[0], 'issued');
    assert.equal(states.length, 2);
  }
}

async function expectPass(device = new FakeDevice()) {
  const result = await executeAndroidLifecycleScenario(config, device);
  assert.equal(result.status, 'passed');
  assert.equal(result.reasonCode, null);
  assert.deepEqual(result.tests.map((test) => test.id), androidLifecycleScenarioPolicy.expectedTestIds);
  assert.equal(result.measurements.timerAdvanceSeconds >= 2, true);
  assert.equal(result.measurements.backgroundTimerAdvanceSeconds >= 6, true);
  assert.equal(result.measurements.screenOffTimerAdvanceSeconds >= 6, true);
  assert.equal(result.measurements.backgroundNativeProgressAdvanced, true);
  assert.equal(result.measurements.screenOffNativeProgressAdvanced, true);
  assert.equal(result.measurements.pausedNativeProgressHeld, true);
  assert.equal(result.measurements.normalSaveNativeInactive, true);
  assert.equal(result.measurements.afterNormalSaveCount, result.measurements.beforeNormalSaveCount + 1);
  assert.equal(result.measurements.afterIdleRestartCount, result.measurements.afterNormalSaveCount);
  assert.equal(result.measurements.afterRecoveryCount, result.measurements.beforeRecoveryCount + 1);
  assert.equal(result.measurements.syntheticMeetingsRetained, 2);
  assert.equal(result.mutations.every((entry) => entry.state === 'confirmed_applied' && entry.attempts === 1), true);
  assert.equal(result.reconciliationRequired, false);
  assertAtMostOneMutation(device);
  cases += 1;
}

async function expectFailure(overrides, reasonCode, verify = () => {}) {
  const device = new FakeDevice(overrides);
  const result = await executeAndroidLifecycleScenario(config, device);
  assert.equal(result.status, 'failed_closed');
  assert.equal(result.reasonCode, reasonCode);
  assertAtMostOneMutation(device);
  verify(result, device);
  cases += 1;
}

await expectPass();
await expectPass(new FakeDevice({ rejectUiReadsWhileRecording: true }));
await expectPass(new FakeDevice({ omitHomeLoadMarker: true }));
await expectPass(new FakeDevice({ homeLoadDelayReads: 3 }));
await expectPass(new FakeDevice({ rollChunkOnProgress: true }));
await expectPass(new FakeDevice({ forceRecoveryRoute: true, durabilityDelayReads: 3 }));
await expectPass(new FakeDevice({ virtualizeOldAfterRecovery: true }));
const initialLaunchFault = new FakeDevice({ countDriftByMutationId: { 'launch-initial-home': -1 } });
await expectPass(initialLaunchFault);
assert.equal(initialLaunchFault.faultHits.get('launch-initial-home'), 1);
assert.equal(initialLaunchFault.faultHits.has('launch-after-idle-force-stop'), false);
const unreachableFault = new FakeDevice({ countDriftByMutationId: { 'not-a-real-mutation': -1 } });
await expectPass(unreachableFault);
assert.equal(unreachableFault.faultHits.size, 0);
await expectFailure({ version: '0.10.67' }, 'INSTALLED_IDENTITY_MISMATCH', (result, device) => {
  assert.equal(result.mutations.length, 0);
  assert.equal(device.mutationCalls.size, 0);
});
await expectFailure({ artifactSha256: 'b'.repeat(64) }, 'INSTALLED_ARTIFACT_MISMATCH', (result, device) => {
  assert.equal(result.mutations.length, 0);
  assert.equal(device.mutationCalls.size, 0);
});
await expectFailure({ homeSelected: false }, 'HOME_NAVIGATION_REQUIRES_SEPARATE_MUTATION');
await expectFailure({ duplicateNotifications: true }, 'HOME_SURFACE_INVALID');
await expectFailure({ freezeTimer: true }, 'RECORDING_TIMER_STALLED', (result) => {
  assert.equal(result.reconciliationRequired, true);
});
await expectFailure({ firstResumeDelayMs: 6_000 }, 'FIRST_RESUME_ACCEPTANCE_TOO_SLOW');
await expectFailure({ duplicateResume: true }, 'RECORDING_SURFACE_INVALID', (result) => {
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.cleanup, 'no_automatic_mutation_after_failure');
});
await expectFailure({ progressWhilePaused: true }, 'PAUSED_NATIVE_PROGRESS_ADVANCED');
await expectFailure({ nativeActiveAfterStop: true }, 'NORMAL_SAVE_NATIVE_CAPTURE_ACTIVE');
await expectFailure({ nativeErrorAfterStop: true }, 'NORMAL_SAVE_NATIVE_CAPTURE_ACTIVE');
await expectFailure({ nativeErrorWhilePaused: true }, 'PAUSED_NATIVE_PROGRESS_ADVANCED');
await expectFailure({ freezeBackgroundProgress: true }, 'BACKGROUND_NATIVE_PROGRESS_STALLED', (result) => {
  assert.equal(result.reconciliationRequired, true);
});
await expectFailure({ freezeScreenOffTimer: true }, 'SCREEN_OFF_TIMER_STALLED', (result) => {
  assert.equal(result.reconciliationRequired, true);
});
await expectFailure({ omitDurability: true, forceRecoveryRoute: true }, 'RECOVERED_DETAIL_TIMEOUT');
await expectFailure({ detailMetadataMismatch: true }, 'RECOVERED_DETAIL_IDENTITY_MISMATCH');
await expectFailure({ detailCorrelationMismatch: true }, 'RECOVERED_DETAIL_IDENTITY_MISMATCH');
await expectFailure({ countDriftByMutationId: { 'launch-after-idle-force-stop': -1 } }, 'IDLE_RESTART_COUNT_DRIFT', (result, device) => {
  assert.equal(device.faultHits.get('launch-after-idle-force-stop'), 1);
  assert.equal(device.faultHits.has('launch-initial-home'), false);
  assert.equal(result.mutations.find((entry) => entry.id === 'launch-after-idle-force-stop')?.state, 'confirmed_applied');
});
await expectFailure({ ambiguousMutationId: 'launch-start-normal', ambiguousMutationApplied: true }, 'LAUNCH_START_NORMAL_AMBIGUOUS', (result, device) => {
  assert.equal(result.reconciliationRequired, true);
  assert.equal(device.mutationCalls.get('launch-start-normal'), 1);
  assert.equal(device.mutationCalls.has('tap-stop-normal'), false);
});
await expectFailure({ ambiguousMutationId: 'tap-stop-normal', ambiguousMutationApplied: true }, 'TAP_STOP_NORMAL_AMBIGUOUS', (result, device) => {
  assert.equal(result.reconciliationRequired, true);
  assert.equal(device.mutationCalls.get('tap-stop-normal'), 1);
  assert.equal(device.mutationCalls.has('back-from-saved-detail'), false);
});
await expectFailure({ notSpawnedMutationId: 'launch-initial-home' }, 'LAUNCH_INITIAL_HOME_NOT_SPAWNED', (result) => {
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.mutations[0].state, 'confirmed_no_effect');
});
await expectFailure({ invalidReceiptMutationId: 'launch-initial-home' }, 'LAUNCH_INITIAL_HOME_RECEIPT_INVALID');

const noJournalDevice = new FakeDevice();
noJournalDevice.recordMutationState = undefined;
const noJournalResult = await executeAndroidLifecycleScenario({ ...config, operational: true }, noJournalDevice);
assert.equal(noJournalResult.status, 'failed_closed');
assert.equal(noJournalResult.reasonCode, 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE');
assert.equal(noJournalDevice.mutationCalls.size, 0);
cases += 1;

const scenarioSource = readFileSync(join(repoRoot, 'scripts/qualification/android-lifecycle-scenario.mjs'), 'utf8');
const recordSource = readFileSync(join(repoRoot, 'src/app/record.tsx'), 'utf8');
const meetingsSource = readFileSync(join(repoRoot, 'src/data/meetings.ts'), 'utf8');
const packetSource = readFileSync(join(repoRoot, 'src/services/meetingPacket.ts'), 'utf8');
const cloudCoreSource = readFileSync(join(repoRoot, 'src/services/mainaKnowledgeCloudCore.ts'), 'utf8');
const layoutSource = readFileSync(join(repoRoot, 'src/app/_layout.tsx'), 'utf8');
const remoteLogSource = readFileSync(join(repoRoot, 'src/services/remoteLog.ts'), 'utf8');
const postProcessingSource = readFileSync(
  join(repoRoot, 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt'),
  'utf8',
);
for (const forbidden of ['screenshot', ' uninstall', ' pm clear', ' clear data', ' reset-permissions', ' install -r']) {
  assert.equal(scenarioSource.includes(forbidden), false, `Scenario contains forbidden text: ${forbidden}`);
}
assert.match(scenarioSource, /testId: 'main-tab-index'/);
assert.doesNotMatch(scenarioSource, /main-tab-home/);
assert.match(recordSource, /authorizeAndroidQualificationSession\([\s\S]*consumeAndroidQualificationSession/);
assert.match(recordSource, /qualificationEvidenceDigest: qualificationEvidenceDigestRef\.current/);
assert.match(recordSource, /qualificationSession: qualificationRunIdRef\.current !== null/);
assert.match(recordSource, /setQualificationDiagnosticsSuppressed\(true\)/);
assert.match(recordSource, /addQualificationDiagnosticMeetingId\(idRef\.current\)/);
assert.ok(layoutSource.indexOf('await initDb();') < layoutSource.indexOf('await installRemoteLog();'));
assert.match(layoutSource, /setQualificationDiagnosticMeetingIds\(/);
assert.match(layoutSource, /isAndroidQualificationSessionActive\(\)\.catch\(\(\) => true\)/);
assert.match(remoteLogSource, /referencesQualificationMeeting\(pending\[index\], protectedMeetingIds\)/);
assert.doesNotMatch(postProcessingSource, /meetingId=\$meetingId|uri=\$uri/);
assert.notEqual(
  deriveQualificationRecordingRunId('00000000-0000-4000-8000-000000000001', 'normal'),
  deriveQualificationRecordingRunId('00000000-0000-4000-8000-000000000001', 'recovery'),
);
assert.match(meetingsSource, /m\.qualification_evidence_digest IS NULL/g);
assert.match(packetSource, /meeting\.qualificationEvidenceDigest == null/);
assert.match(cloudCoreSource, /meeting\.qualificationEvidenceDigest != null\) return false/);
assert.equal(androidLifecycleScenarioPolicy.physicalIncomingCallTestPerformed, false);
assert.equal(androidLifecycleScenarioPolicy.rawScreenshotsAllowed, false);
assert.equal(androidLifecycleScenarioPolicy.rawHierarchyPersistenceAllowed, false);
assert.deepEqual(androidLifecycleScenarioPolicy.allowedMutations, [
  'arm_qualification', 'force_stop', 'launch_main', 'launch_record_qualification', 'pause_qualification', 'press_back', 'press_home', 'sleep_device', 'tap', 'wake_up',
]);

const creators = readdirSync(join(repoRoot, 'src/app'), { recursive: true })
  .filter((path) => /\.(?:ts|tsx)$/u.test(path) && !/\.test\.(?:ts|tsx)$/u.test(path))
  .flatMap((path) => {
    const matches = readFileSync(join(repoRoot, 'src/app', path), 'utf8').match(/\bcreateMeeting\s*\(/gu) ?? [];
    return matches.map(() => path);
  });
assert.deepEqual(creators, ['record.tsx']);

console.log(`Android lifecycle scenario verified (${cases} complete fake-device cases; at-most-once mutation and source-exclusivity boundaries passed).`);
