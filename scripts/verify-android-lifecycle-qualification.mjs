#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidLifecyclePolicy,
  classifyDurableAudioEvidence,
  classifyMainaRecordingNotification,
  classifyPowerState,
  classifyRecoveryDurability,
  classifyRecordingSurface,
  classifySavedDetailDurability,
  observeHomeSurface,
  observeRecordingSurface,
  optionalUniqueAction,
  optionalUniqueMarker,
  parsePublicRecordingCount,
  parseRecordingTimer,
  parseUiAutomatorHierarchy,
  readUniqueMarkerLabel,
  requireNoActiveRecordingSurface,
  requireOneNewRecording,
  requireTimerAdvance,
  requireTimerHeld,
  requireUniqueAction,
  selectTopMeetingCard,
} from './qualification/android-lifecycle-core.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recordSource = readFileSync(join(repoRoot, 'src/app/record.tsx'), 'utf8');
const homeSource = readFileSync(join(repoRoot, 'src/app/(tabs)/index.tsx'), 'utf8');
const shellSource = readFileSync(join(repoRoot, 'src/design/shell.tsx'), 'utf8');
const detailSource = readFileSync(join(repoRoot, 'src/app/meeting/[id].tsx'), 'utf8');
const recoverySource = readFileSync(join(repoRoot, 'src/app/meeting/[id]/recover.tsx'), 'utf8');
let assertions = 0;

function node(attributes) {
  const values = {
    index: '0',
    text: '',
    'resource-id': '',
    class: 'android.view.View',
    package: 'com.divay.maina',
    'content-desc': '',
    checkable: 'false',
    checked: 'false',
    clickable: 'false',
    enabled: 'true',
    focusable: 'false',
    focused: 'false',
    scrollable: 'false',
    'long-clickable': 'false',
    password: 'false',
    selected: 'false',
    bounds: '[0,0][100,100]',
    'visible-to-user': 'true',
    ...attributes,
  };
  return `<node ${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
}

function hierarchy(...nodes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hierarchy rotation="0">${nodes.join('')}</hierarchy>`;
}

function parse(...nodes) {
  return parseUiAutomatorHierarchy(hierarchy(...nodes));
}

function passes(callback) {
  callback();
  assertions += 1;
}

function rejects(callback, pattern) {
  assert.throws(callback, pattern);
  assertions += 1;
}

const recording = parse(
  node({ text: '0:04', 'resource-id': 'com.divay.maina:id/recording-timer' }),
  node({ text: 'Recording', 'resource-id': 'com.divay.maina:id/recording-state' }),
  node({ text: 'Stop and save', 'resource-id': 'com.divay.maina:id/recording-stop-save', clickable: 'true', bounds: '[10,100][210,180]' }),
  node({ text: 'Pause', 'resource-id': 'com.divay.maina:id/recording-pause-resume', clickable: 'true', bounds: '[10,200][210,280]' }),
  node({ text: 'Discard this recording', 'resource-id': 'recording-discard', clickable: 'true' }),
);
assert.deepEqual(classifyRecordingSurface(recording), { state: 'recording', timerSeconds: 4 });
assert.deepEqual(requireUniqueAction(recording, { label: 'Pause', testId: 'recording-pause-resume' }), { x: 110, y: 240 });
assert.throws(
  () => requireUniqueAction(recording, { label: 'Resume', testId: 'recording-pause-resume' }),
  /missing or ambiguous/,
);
assert.equal(parseRecordingTimer(recording), 4);
assert.equal(requireTimerAdvance(4, 7, 2), 3);
assertions += 5;

const paused = parse(
  node({ text: '1:02:03', 'resource-id': 'recording-timer' }),
  node({ text: 'Paused', 'resource-id': 'recording-state' }),
  node({ text: 'Stop and save', 'resource-id': 'recording-stop-save', clickable: 'true' }),
  node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true' }),
  node({ text: 'Discard this recording', 'resource-id': 'recording-discard', clickable: 'true' }),
);
assert.deepEqual(classifyRecordingSurface(paused), { state: 'paused', timerSeconds: 3723 });
assert.equal(requireTimerHeld(3723, 3723), 3723);
assert.equal(observeRecordingSurface(paused)?.state, 'paused');
assert.equal(observeRecordingSurface(parse(node({ text: 'Home' }))), null);
assert.equal(observeRecordingSurface(parse(node({ text: '0:01', 'resource-id': 'recording-timer' }))), null);
assertions += 5;

rejects(() => classifyRecordingSurface(parse(
  node({ text: '0:04', 'resource-id': 'recording-timer' }),
  node({ text: 'Paused', 'resource-id': 'recording-state' }),
  node({ text: 'Stop and save', 'resource-id': 'recording-stop-save', clickable: 'true' }),
  node({ text: 'Pause', 'resource-id': 'recording-pause-resume', clickable: 'true' }),
  node({ text: 'Discard this recording', 'resource-id': 'recording-discard', clickable: 'true' }),
)), /disagree/);
rejects(() => requireUniqueAction(parse(
  node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true' }),
  node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true', bounds: '[0,101][100,201]' }),
), { label: 'Resume', testId: 'recording-pause-resume' }), /ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'false' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', clickable: 'true' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', 'resource-id': 'wrong-control', clickable: 'true' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', 'resource-id': 'recording-pause-resume', package: 'com.attacker', clickable: 'true' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => parseRecordingTimer(parse(node({ text: '0:60', 'resource-id': 'recording-timer' }))), /range/);
rejects(() => parseRecordingTimer(parse(node({ text: '0:04' }))), /missing or ambiguous/);
rejects(() => requireTimerAdvance(8, 8), /did not advance/);
rejects(() => requireTimerHeld(8, 9), /advanced/);
rejects(() => observeRecordingSurface(parse(
  node({ text: '0:04', 'resource-id': 'recording-timer' }),
  node({ text: '0:05', 'resource-id': 'recording-timer' }),
)), /ambiguous/);
assert.equal(optionalUniqueAction(recording, { label: 'Pause', testId: 'recording-pause-resume' })?.y, 240);
assert.equal(optionalUniqueAction(recording, { label: 'Resume', testId: 'recording-pause-resume' }), null);
assert.equal(optionalUniqueMarker(parse(node({ 'resource-id': 'meeting-recovery-root' })), 'meeting-recovery-root'), true);
assert.equal(optionalUniqueMarker(parse(node({ text: 'other' })), 'meeting-recovery-root'), null);
assertions += 4;

const homeBefore = parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'true', bounds: '[0,900][200,1000]' }),
  node({ text: 'Notifications', clickable: 'true', bounds: '[800,0][900,100]' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true', bounds: '[400,900][600,1000]' }),
  node({ text: 'Recent' }),
  node({ text: '12 recordings', 'resource-id': 'recording-count' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,300][990,500]' }),
  node({ text: 'Sep 11 · 8:00 AM · 1:00', 'resource-id': 'meeting-card-metadata', bounds: '[20,320][900,360]' }),
  node({ 'resource-id': 'meeting-card-correlation-existing-meeting', bounds: '[20,360][900,380]' }),
);
const homeAfter = parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'true', bounds: '[0,900][200,1000]' }),
  node({ text: 'Notifications', clickable: 'true', bounds: '[800,0][900,100]' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true', bounds: '[400,900][600,1000]' }),
  node({ 'resource-id': 'meeting-list-loaded' }),
  node({ text: 'Recent' }),
  node({ text: '13 recordings', 'resource-id': 'recording-count' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,260][990,460]' }),
  node({ text: 'Sep 11 · 8:10 AM · 0:20', 'resource-id': 'meeting-card-metadata', bounds: '[20,280][900,320]' }),
  node({ 'resource-id': 'meeting-card-correlation-new-meeting', bounds: '[20,320][900,340]' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,500][990,700]' }),
  node({ text: 'Sep 11 · 8:00 AM · 1:00', 'resource-id': 'meeting-card-metadata', bounds: '[20,520][900,560]' }),
  node({ 'resource-id': 'meeting-card-correlation-existing-meeting', bounds: '[20,560][900,580]' }),
  node({ text: 'Notes ready', bounds: '[20,570][900,600]' }),
  node({ text: 'Mutable summary changed during post-processing.', bounds: '[20,610][900,650]' }),
);
assert.equal(parsePublicRecordingCount(homeBefore), 12);
assert.equal(parsePublicRecordingCount(homeAfter), 13);
assert.deepEqual(observeHomeSurface(homeBefore), {
  record: { x: 500, y: 950 },
  recordingCount: 12,
  legacyLoadedMarkerPresent: false,
});
assert.equal(observeHomeSurface(homeAfter)?.legacyLoadedMarkerPresent, true);
assert.equal(requireOneNewRecording(12, 13), 13);
assert.deepEqual(selectTopMeetingCard(homeAfter), {
  visibleCardCount: 2,
  privateCorrelationToken: 'new-meeting',
  privateMetadata: 'Sep 11 · 8:10 AM · 0:20',
  x: 500,
  y: 360,
});
assert.equal(readUniqueMarkerLabel(homeBefore, 'meeting-card-metadata'), 'Sep 11 · 8:00 AM · 1:00');
assertions += 7;
assert.equal(observeHomeSurface(parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'false' }),
  node({ text: 'Notifications', clickable: 'true' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true' }),
  node({ text: '12 recordings', 'resource-id': 'recording-count' }),
)), null);
rejects(() => observeHomeSurface(parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'true' }),
  node({ text: 'Notifications', clickable: 'true' }),
  node({ text: 'Notifications', clickable: 'true', bounds: '[0,101][100,201]' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true' }),
  node({ text: '12 recordings', 'resource-id': 'recording-count' }),
)), /ambiguous/);
assert.equal(observeHomeSurface(parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'true' }),
  node({ text: 'Notifications', clickable: 'true' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true' }),
  node({ text: '12 recordings', 'resource-id': 'recording-count' }),
  node({ text: 'Allow', package: 'com.android.permissioncontroller' }),
)), null);
assert.equal(observeHomeSurface(parse(
  node({ text: 'Home', 'resource-id': 'main-tab-index', clickable: 'true', selected: 'true' }),
  node({ text: 'Notifications', clickable: 'true' }),
  node({ text: 'Record a meeting', 'resource-id': 'record-meeting', clickable: 'true' }),
  node({ text: '12 recordings', 'resource-id': 'recording-count' }),
  node({ text: 'Allow' }),
))?.recordingCount, 12);
rejects(() => parse(node({ selected: 'unknown' })), /invalid selected/);
assertions += 3;
rejects(() => requireOneNewRecording(12, 14), /exactly one/);
rejects(() => parsePublicRecordingCount(parse(node({ text: '13 recordings', 'resource-id': 'recording-count' }), node({ 'content-desc': '13 recordings', 'resource-id': 'recording-count' }))), /ambiguous/);
rejects(() => parsePublicRecordingCount(parse(node({ text: '13 recordings' }))), /missing or ambiguous/);
rejects(() => selectTopMeetingCard(parse(
  node({ 'resource-id': 'meeting-card', clickable: 'true', bounds: '[10,260][400,460]' }),
  node({ 'resource-id': 'meeting-card', clickable: 'true', bounds: '[500,260][990,460]' }),
)), /ambiguous/);
rejects(() => selectTopMeetingCard(parse(node({ text: 'Meeting title', clickable: 'true' }))), /No stable/);
rejects(() => selectTopMeetingCard(parse(
  node({ 'resource-id': 'meeting-card', clickable: 'true', bounds: '[10,260][990,460]' }),
)), /metadata/);
rejects(() => selectTopMeetingCard(parse(
  node({ 'resource-id': 'meeting-card', package: 'com.attacker', clickable: 'true', bounds: '[10,260][990,460]' }),
  node({ text: 'Sep 11 · 8:10 AM · 0:20', 'resource-id': 'meeting-card-metadata', package: 'com.attacker', bounds: '[20,280][900,320]' }),
)), /No stable/);

const recoverDetail = parse(
  node({ text: 'Saved audio segments: 2' }),
  node({ text: 'Audio available: Yes' }),
  node({ text: 'Re-transcribe from saved audio', clickable: 'true' }),
);
assert.deepEqual(classifyDurableAudioEvidence(recoverDetail), {
  audioAvailable: 1,
  positiveSegments: 1,
  audioKept: 0,
  retranscribe: 1,
});
assert.equal(requireNoActiveRecordingSurface(recoverDetail), true);
assertions += 2;

const detailAudioKept = parse(node({ text: 'No transcript · audio kept', 'resource-id': 'meeting-detail-audio-state' }));
assert.equal(classifyDurableAudioEvidence(detailAudioKept).audioKept, 1);
assertions += 1;
rejects(() => classifyDurableAudioEvidence(parse(node({ text: 'Audio available: No' }))), /absent/);
rejects(() => classifyDurableAudioEvidence(parse(node({ text: 'Audio available: Yes' }), node({ 'content-desc': 'Audio available: Yes' }))), /ambiguous/);
rejects(() => requireNoActiveRecordingSurface(parse(node({ text: 'Stop and save', clickable: 'true' }))), /active recording/);

const exactSavedDetail = parse(
  node({ text: 'Delete meeting', 'resource-id': 'meeting-detail-delete', clickable: 'true' }),
  node({ text: 'Sep 11 · 8:10 AM · 0:20', 'resource-id': 'meeting-detail-metadata' }),
  node({ text: 'No transcript · audio kept', 'resource-id': 'meeting-detail-audio-state' }),
);
assert.deepEqual(classifySavedDetailDurability(exactSavedDetail), {
  audioAvailable: 1,
  positiveSegments: 1,
  retranscribe: 0,
});
assertions += 1;
rejects(() => classifySavedDetailDurability(parse(
  node({ text: 'Delete meeting', 'resource-id': 'meeting-detail-delete', clickable: 'true' }),
  node({ text: 'No transcript', 'resource-id': 'meeting-detail-audio-state' }),
)), /not positive/);

const exactRecovery = parse(
  node({ 'resource-id': 'meeting-recovery-root' }),
  node({ text: 'Saved audio segments: 2', 'resource-id': 'meeting-recovery-segments' }),
  node({ text: 'Audio available: Yes', 'resource-id': 'meeting-recovery-audio' }),
  node({ text: 'Re-transcribe from saved audio', 'resource-id': 'meeting-recovery-retranscribe', clickable: 'true' }),
);
assert.deepEqual(classifyRecoveryDurability(exactRecovery), {
  audioAvailable: 1,
  positiveSegments: 1,
  retranscribe: 1,
});
assertions += 1;
rejects(() => classifyRecoveryDurability(parse(
  node({ 'resource-id': 'meeting-recovery-root' }),
  node({ text: 'Saved audio segments: 0', 'resource-id': 'meeting-recovery-segments' }),
  node({ text: 'Audio available: Yes', 'resource-id': 'meeting-recovery-audio' }),
  node({ text: 'Re-transcribe from saved audio', 'resource-id': 'meeting-recovery-retranscribe', clickable: 'true' }),
)), /segment count/);
rejects(() => classifyRecoveryDurability(parse(
  node({ 'resource-id': 'meeting-recovery-root' }),
  node({ text: 'Saved audio segments: 2', 'resource-id': 'meeting-recovery-segments' }),
  node({ text: 'Audio available: No', 'resource-id': 'meeting-recovery-audio' }),
  node({ text: 'Re-transcribe from saved audio', 'resource-id': 'meeting-recovery-retranscribe', clickable: 'true' }),
)), /availability/);
rejects(() => classifyRecoveryDurability(parse(
  node({ 'resource-id': 'meeting-recovery-root' }),
  node({ 'resource-id': 'meeting-recovery-root' }),
  node({ text: 'Saved audio segments: 2', 'resource-id': 'meeting-recovery-segments' }),
  node({ text: 'Audio available: Yes', 'resource-id': 'meeting-recovery-audio' }),
  node({ text: 'Re-transcribe from saved audio', 'resource-id': 'meeting-recovery-retranscribe', clickable: 'true' }),
)), /ambiguous/);

const displayDump = (state, {
  size = 1,
  id = 0,
  controllerSize = 1,
  transition = false,
  extraPhotonicState = '',
} = {}) => [
  `Display States: size=${size}`,
  '---------------------',
  `  Display Id=${id}`,
  `  Display State=${state}`,
  '  Display Brightness=0.5',
  '  Display SdrBrightness=0.5',
  '',
  'Display Adapters: size=1',
  '',
  `Display Power Controllers: size=${controllerSize}`,
  '',
  'Display Power Controller:',
  '-------------------------',
  '  mDisplayId=0',
  '',
  'Photonic Modulator State:',
  `  mPendingState=${state}`,
  '  mPendingBacklight=0.5',
  '  mPendingSdrBacklight=0.5',
  `  mActualState=${state}`,
  '  mActualBacklight=0.5',
  '  mActualSdrBacklight=0.5',
  `  mStateChangeInProgress=${transition}`,
  '  mBacklightChangeInProgress=false',
  extraPhotonicState,
].join('\n');
assert.equal(classifyPowerState(
  'Power Manager State:\n  mWakefulness=Awake\n  mWakefulnessChanging=false\nDisplay Power: com.android.server.power.PowerManagerService$4@opaque\n',
  displayDump('ON'),
), 'on');
assert.equal(classifyPowerState(
  'Power Manager State:\r\n  mWakefulness=Asleep\r\n  mWakefulnessChanging=false\r\nDisplay Power: com.android.server.power.PowerManagerService$4@opaque\r\n',
  displayDump('OFF').replace(/\n/gu, '\r\n'),
), 'off');
assert.equal(classifyPowerState(
  'Power Manager State:\n  mWakefulness=Dozing\n  mWakefulnessChanging=false\n',
  displayDump('OFF'),
), 'off');
assertions += 3;
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulness=Asleep\n  mWakefulnessChanging=false\n', displayDump('ON')), /ambiguous/);
assert.equal(classifyPowerState('  mWakefulness=Dozing\n  mWakefulnessChanging=false\n', displayDump('DOZE')), 'ambient');
assert.equal(classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=true\n', displayDump('ON')), 'transitioning');
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('OFF')), /not an exact/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n', displayDump('ON')), /transition state/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n  mWakefulnessChanging=false\n', displayDump('ON')), /ambiguous/);
rejects(() => classifyPowerState('    mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON')), /Power state/);
assert.equal(
  classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON', { transition: true })),
  'transitioning',
);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON', { size: 2 })), /section/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON', { id: 1 })), /Default display/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON', { controllerSize: 2 })), /controller section/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', `${displayDump('ON')}\nDisplay States: size=1\n`), /section/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', displayDump('ON', {
  extraPhotonicState: '\nPhotonic Modulator State:\n  mPendingState=ON\n  mPendingBacklight=0.5\n  mPendingSdrBacklight=0.5\n  mActualState=ON\n  mActualBacklight=0.5\n  mActualSdrBacklight=0.5\n  mStateChangeInProgress=false\n  mBacklightChangeInProgress=false',
})), /controller state/);
rejects(() => classifyPowerState('  mWakefulness=Awake\n  mWakefulnessChanging=false\n', ''), /nonempty/);
assertions += 3;

const readyNotification = [
  'NotificationRecord(0x00000001: pkg=com.divay.maina user=UserHandle{0} id=7001 tag=null importance=2 key=synthetic: Notification(channel=maina_recording shortcut=null contentView=null))',
  'android.title=String (Maina is ready)',
].join('\n');
assert.equal(classifyMainaRecordingNotification(readyNotification, 'com.divay.maina'), 'ready');
assert.equal(classifyMainaRecordingNotification(readyNotification.replace('Maina is ready', 'Maina is recording'), 'com.divay.maina'), 'recording');
assert.equal(classifyMainaRecordingNotification(readyNotification.replace('Maina is ready', 'PRIVATE SENTINEL'), 'com.divay.maina'), 'unavailable/ambiguous');
assert.equal(classifyMainaRecordingNotification(`${readyNotification}\n${readyNotification}`, 'com.divay.maina'), 'unavailable/ambiguous');
assert.equal(classifyMainaRecordingNotification(readyNotification.replace('channel=maina_recording shortcut=', 'channel=maina_recording-extra shortcut='), 'com.divay.maina'), 'unavailable/ambiguous');
assert.equal(classifyMainaRecordingNotification(readyNotification.replace('channel=maina_recording shortcut=null contentView=null', 'channel=maina_recording'), 'com.divay.maina'), 'unavailable/ambiguous');
assertions += 6;

rejects(() => parseUiAutomatorHierarchy('<hierarchy></hierarchy>'), /no nodes/);
rejects(() => parseUiAutomatorHierarchy(`${hierarchy(node({ text: 'ok' }))}<hierarchy></hierarchy>`), /cardinality/);
rejects(() => parseUiAutomatorHierarchy(hierarchy('<node text="a" text="b" />')), /duplicate/);
rejects(() => parseUiAutomatorHierarchy(hierarchy('<node text="a" ??? />')), /unconsumed/);
rejects(() => parseUiAutomatorHierarchy(hierarchy('<node></node>')), /unparsed/);
passes(() => parseUiAutomatorHierarchy(hierarchy(node({ text: 'A &amp; B' }))));

const productionSources = Object.freeze({
  detail: detailSource,
  home: homeSource,
  record: recordSource,
  recovery: recoverySource,
  shell: shellSource,
});
const ownerByTestId = Object.freeze({
  'recording-timer': 'record',
  'recording-state': 'record',
  'recording-stop-save': 'record',
  'recording-pause-resume': 'record',
  'recording-discard': 'record',
  'recording-recovery-keep': 'record',
  'meeting-detail-delete': 'detail',
  'meeting-detail-metadata': 'detail',
  'meeting-detail-audio-state': 'detail',
  'meeting-tab-transcript': 'detail',
  'meeting-recovery-root': 'recovery',
  'meeting-recovery-metadata': 'recovery',
  'meeting-recovery-segments': 'recovery',
  'meeting-recovery-audio': 'recovery',
  'meeting-recovery-retranscribe': 'recovery',
  'meeting-recovery-open-saved': 'recovery',
  'record-meeting': 'shell',
  'meeting-list-loaded': 'home',
  'recording-count': 'home',
  'meeting-card': 'home',
  'meeting-card-metadata': 'home',
});

function verifySourceOwnership(policyIds, ownership, sources) {
  assert.deepEqual(Object.keys(ownership).sort(), [...policyIds].sort(), 'Lifecycle test-ID ownership is not closed.');
  for (const [testId, owner] of Object.entries(ownership)) {
    assert.equal(Object.hasOwn(sources, owner), true, `Unknown source owner for ${testId}.`);
    const expression = new RegExp(`testID=["']${testId}["']`, 'g');
    assert.equal(sources[owner].match(expression)?.length ?? 0, 1, `${testId} must occur exactly once in ${owner}.`);
    for (const [otherOwner, source] of Object.entries(sources)) {
      if (otherOwner === owner) continue;
      assert.equal(source.match(expression)?.length ?? 0, 0, `${testId} appears outside ${owner}.`);
    }
  }
}

verifySourceOwnership(androidLifecyclePolicy.exactTestIds, ownerByTestId, productionSources);
assertions += androidLifecyclePolicy.exactTestIds.length;
rejects(() => verifySourceOwnership(androidLifecyclePolicy.exactTestIds, {
  ...ownerByTestId,
  unexpected: 'record',
}, productionSources), /not closed/);
rejects(() => verifySourceOwnership(androidLifecyclePolicy.exactTestIds, {
  ...ownerByTestId,
  'meeting-detail-delete': 'record',
}, productionSources), /exactly once/);
rejects(() => verifySourceOwnership(androidLifecyclePolicy.exactTestIds, ownerByTestId, {
  ...productionSources,
  home: `${homeSource}\ntestID="meeting-detail-delete"`,
}), /outside detail/);
assert.match(
  homeSource,
  /<AppText testID="recording-count" variant="meta" muted>\s*\{meetings\.length\} recording\{meetings\.length === 1 \? '' : 's'\}\s*<\/AppText>/,
);
assert.doesNotMatch(homeSource, /testID="recording-count"[^>]*>\s*\{meta\}/);
assert.match(homeSource, /meeting-card-correlation-\$\{item\.id\}/);
assert.match(detailSource, /meeting-detail-correlation-\$\{meeting\.id\}/);
assert.match(recoverySource, /meeting-recovery-correlation-\$\{meeting\.id\}/);
assert.match(detailSource, /formatMeetingLength\(meeting\)\}\{meeting\.language/);
assert.match(recoverySource, /formatMeetingLength\(meeting\)\}\{meeting\.language/);
assert.doesNotMatch(detailSource, /formatMeetingLength\(meeting\)\}\$/);
assert.doesNotMatch(recoverySource, /formatMeetingLength\(meeting\)\}\$/);
assert.match(recoverySource, /candidateRecoveryAudioUris\(\s*nativeInspection\?\.finalizedUris \?\? \[\],\s*segments\.map/);
assertions += 10;
assert.equal(androidLifecyclePolicy.rawHierarchyPersistenceAllowed, false);
assert.equal(androidLifecyclePolicy.processRecoveryRecordingDelta, 1);
assertions += 2;

console.log(`Android lifecycle qualification core verified (${assertions} adversarial assertions).`);
