#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidLifecyclePolicy,
  classifyDurableAudioEvidence,
  classifyPowerState,
  classifyRecordingSurface,
  parsePublicRecordingCount,
  parseRecordingTimer,
  parseUiAutomatorHierarchy,
  requireNoActiveRecordingSurface,
  requireOneNewRecording,
  requireTimerAdvance,
  requireUniqueAction,
  selectTopMeetingCard,
} from './qualification/android-lifecycle-core.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const recordSource = readFileSync(join(repoRoot, 'src/app/record.tsx'), 'utf8');
const homeSource = readFileSync(join(repoRoot, 'src/app/(tabs)/index.tsx'), 'utf8');
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
  node({ text: 'Discard this recording' }),
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
  node({ text: 'Discard this recording' }),
);
assert.deepEqual(classifyRecordingSurface(paused), { state: 'paused', timerSeconds: 3723 });
assertions += 1;

rejects(() => classifyRecordingSurface(parse(
  node({ text: '0:04', 'resource-id': 'recording-timer' }),
  node({ text: 'Paused' }),
  node({ text: 'Stop and save', 'resource-id': 'recording-stop-save', clickable: 'true' }),
  node({ text: 'Pause', 'resource-id': 'recording-pause-resume', clickable: 'true' }),
  node({ text: 'Discard this recording' }),
)), /disagree/);
rejects(() => requireUniqueAction(parse(
  node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true' }),
  node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true', bounds: '[0,101][100,201]' }),
), { label: 'Resume', testId: 'recording-pause-resume' }), /ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'false' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', clickable: 'true' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => requireUniqueAction(parse(node({ text: 'Resume', 'resource-id': 'wrong-control', clickable: 'true' })), { label: 'Resume', testId: 'recording-pause-resume' }), /missing or ambiguous/);
rejects(() => parseRecordingTimer(parse(node({ text: '0:60' }))), /range/);
rejects(() => requireTimerAdvance(8, 8), /did not advance/);

const homeBefore = parse(
  node({ text: 'Recent' }),
  node({ text: '12 recordings' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,300][990,500]' }),
);
const homeAfter = parse(
  node({ text: 'Recent' }),
  node({ text: '13 recordings' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,260][990,460]' }),
  node({ 'resource-id': 'com.divay.maina:id/meeting-card', clickable: 'true', bounds: '[10,500][990,700]' }),
);
assert.equal(parsePublicRecordingCount(homeBefore), 12);
assert.equal(parsePublicRecordingCount(homeAfter), 13);
assert.equal(requireOneNewRecording(12, 13), 13);
assert.deepEqual(selectTopMeetingCard(homeAfter), { visibleCardCount: 2, x: 500, y: 360 });
assertions += 4;
rejects(() => requireOneNewRecording(12, 14), /exactly one/);
rejects(() => parsePublicRecordingCount(parse(node({ text: '13 recordings' }), node({ 'content-desc': '13 recordings' }))), /ambiguous/);
rejects(() => selectTopMeetingCard(parse(
  node({ 'resource-id': 'meeting-card', clickable: 'true', bounds: '[10,260][400,460]' }),
  node({ 'resource-id': 'meeting-card', clickable: 'true', bounds: '[500,260][990,460]' }),
)), /ambiguous/);
rejects(() => selectTopMeetingCard(parse(node({ text: 'Meeting title', clickable: 'true' }))), /No stable/);

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

const detailAudioKept = parse(node({ text: 'No transcript · audio kept' }));
assert.equal(classifyDurableAudioEvidence(detailAudioKept).audioKept, 1);
assertions += 1;
rejects(() => classifyDurableAudioEvidence(parse(node({ text: 'Audio available: No' }))), /absent/);
rejects(() => classifyDurableAudioEvidence(parse(node({ text: 'Audio available: Yes' }), node({ 'content-desc': 'Audio available: Yes' }))), /ambiguous/);
rejects(() => requireNoActiveRecordingSurface(parse(node({ text: 'Stop and save', clickable: 'true' }))), /active recording/);

assert.equal(classifyPowerState('Power Manager State:\n  mWakefulness=Awake\nDisplay Power: state=ON\n'), 'on');
assert.equal(classifyPowerState('Power Manager State:\n  mWakefulness=Asleep\nDisplay Power: state=OFF\n'), 'off');
assertions += 2;
rejects(() => classifyPowerState('mWakefulness=Awake\nDisplay Power: state=OFF\n'), /not an exact/);
rejects(() => classifyPowerState('mWakefulness=Awake\nmWakefulness=Asleep\nDisplay Power: state=OFF\n'), /ambiguous/);
rejects(() => classifyPowerState('mWakefulness=Dozing\nDisplay Power: state=DOZE\n'), /not an exact/);

rejects(() => parseUiAutomatorHierarchy('<hierarchy></hierarchy>'), /no nodes/);
rejects(() => parseUiAutomatorHierarchy(`${hierarchy(node({ text: 'ok' }))}<hierarchy></hierarchy>`), /cardinality/);
rejects(() => parseUiAutomatorHierarchy(hierarchy('<node text="a" text="b" />')), /duplicate/);
rejects(() => parseUiAutomatorHierarchy(hierarchy('<node text="a" ??? />')), /unconsumed/);
passes(() => parseUiAutomatorHierarchy(hierarchy(node({ text: 'A &amp; B' }))));

for (const testId of androidLifecyclePolicy.exactTestIds) {
  const source = testId === 'meeting-card' ? homeSource : recordSource;
  assert.match(source, new RegExp(`testID=["']${testId}["']`));
  assertions += 1;
}
assert.equal(androidLifecyclePolicy.rawHierarchyPersistenceAllowed, false);
assert.equal(androidLifecyclePolicy.processRecoveryRecordingDelta, 1);
assertions += 2;

console.log(`Android lifecycle qualification core verified (${assertions} adversarial assertions).`);
