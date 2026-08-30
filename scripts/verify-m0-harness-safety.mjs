import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const replay = read('scripts/m0-replay-harness.sh');
const stop = read('scripts/stop-dual-device-soak.sh');
const ui = read('ios-tests/MainaUITests.swift');

const forbidden = [
  ['replay harness', replay, '--terminate-existing'],
  ['replay harness', replay, 'force-stop'],
  ['soak stop', stop, 'debugserver'],
  ['soak stop', stop, 'process detach'],
  ['soak stop', stop, '--terminate-existing'],
];

for (const [label, body, token] of forbidden) {
  if (body.includes(token)) throw new Error(`${label} contains forbidden active-test token: ${token}`);
}

for (const token of ['monitor_healthy', 'kill -0', 'monitors_healthy', 'health)']) {
  if (!replay.includes(token)) throw new Error(`Replay harness is missing safety token: ${token}`);
}

for (const token of ['test-without-building', 'MAINA_UI_ATTACH_RUNNING=1', 'testStopExistingRecording']) {
  if (!stop.includes(token)) throw new Error(`Soak stop is missing attach-only UI-test token: ${token}`);
}

for (const token of ['attachesToRunningApp', 'app.activate()', 'testStopExistingRecording']) {
  if (!ui.includes(token)) throw new Error(`UI test is missing attach-only behavior: ${token}`);
}

const attachBranch = ui.slice(ui.indexOf('if attachesToRunningApp'), ui.indexOf('app.launch()'));
if (!attachBranch.includes('return')) throw new Error('Attach-only setup does not return before app.launch().');

console.log('M0 harness safety verification passed.');
