#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const absolute = (relative) => path.join(root, relative);
const read = (relative) => fs.readFileSync(absolute(relative), 'utf8');
const readIfPresent = (relative) => fs.existsSync(absolute(relative)) ? read(relative) : null;

const replayPath = absolute('scripts/m0-replay-harness.sh');
const replay = read('scripts/m0-replay-harness.sh');
const stop = readIfPresent('scripts/stop-dual-device-soak.sh');
const ui = readIfPresent('ios-tests/MainaUITests.swift');
const adbTarget = readIfPresent('scripts/adb-target.sh');

execFileSync('/bin/bash', ['-n', replayPath], { stdio: 'inherit' });

for (const [label, body, token] of [
  ['replay harness', replay, '--terminate-existing'],
  ['replay harness', replay, 'force-stop'],
  ['soak stop', stop ?? '', 'debugserver'],
  ['soak stop', stop ?? '', 'process detach'],
  ['soak stop', stop ?? '', '--terminate-existing'],
]) {
  if (body.includes(token)) throw new Error(`${label} contains forbidden active-test token: ${token}`);
}

for (const token of ['monitor_healthy', 'kill -0', 'monitors_healthy', 'health)']) {
  if (!replay.includes(token)) throw new Error(`Replay harness is missing safety token: ${token}`);
}

if (adbTarget) {
  const androidHarness = `${replay}\n${adbTarget}`;
  for (const token of ['._adb-tls-connect._tcp', 'getprop ro.serialno', 'getprop ro.product.model']) {
    if (!androidHarness.includes(token)) throw new Error(`Wireless Android target safety is missing: ${token}`);
  }
}

if ((stop == null) !== (ui == null)) {
  throw new Error('iOS attach-only stop harness and UI test must be present together.');
}
if (stop && ui) {
  for (const token of ['test-without-building', 'MAINA_UI_ATTACH_RUNNING=1', 'testStopExistingRecording']) {
    if (!stop.includes(token)) throw new Error(`Soak stop is missing attach-only UI-test token: ${token}`);
  }
  for (const token of ['attachesToRunningApp', 'app.activate()', 'testStopExistingRecording']) {
    if (!ui.includes(token)) throw new Error(`UI test is missing attach-only behavior: ${token}`);
  }
  const attachBranch = ui.slice(ui.indexOf('if attachesToRunningApp'), ui.indexOf('app.launch()'));
  if (!attachBranch.includes('return')) throw new Error('Attach-only setup does not return before app.launch().');
}

console.log('M0 harness safety verification passed.');
