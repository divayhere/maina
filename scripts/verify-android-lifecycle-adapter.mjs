#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  AndroidLifecycleAdapterFailure,
  androidLifecycleAdapterPolicy,
  createAndroidLifecycleAdbTools,
  parseInstalledApkPath,
  parseInstalledApkSha256,
  parseCaptureQualificationDump,
  parseForegroundState,
  parseInstalledIdentity,
  parseProcessState,
  parseUiHierarchyCommandOutput,
} from './qualification/android-lifecycle-adapter.mjs';
import {
  androidLifecycleScenarioPolicy,
  deriveQualificationEvidenceDigest,
  deriveQualificationRecordingRunId,
  executeAndroidLifecycleScenario,
} from './qualification/android-lifecycle-scenario.mjs';

const adb = '/synthetic/android-sdk/platform-tools/adb';
const serial = 'adb-synthetic._adb-tls-connect._tcp';
const qualificationRunId = '00000000-0000-4000-8000-000000000001';
const privateSentinel = 'PRIVATE_SENTINEL_MUST_NOT_PERSIST';
const syntheticArtifactSha256 = 'a'.repeat(64);
const installedApkPath = '/data/app/~~synthetic/com.divay.maina-abc/base.apk';

function result({
  spawned = true,
  exitCode = 0,
  signal = null,
  timedOut = false,
  outputTruncated = false,
  stdout = '',
  stderr = '',
} = {}) {
  return { spawned, exitCode, signal, timedOut, outputTruncated, stdout, stderr };
}

function xmlNode(attributes) {
  const values = {
    text: '',
    'resource-id': '',
    class: 'android.view.View',
    package: 'com.divay.maina',
    'content-desc': '',
    clickable: 'false',
    enabled: 'true',
    selected: 'false',
    bounds: '[0,0][100,100]',
    'visible-to-user': 'true',
    ...attributes,
  };
  return `<node ${Object.entries(values).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
}

function hierarchy(...items) {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${items.join('')}</hierarchy>`;
}

function action(text, id, top, attributes = {}) {
  return xmlNode({ text, 'resource-id': id, clickable: 'true', bounds: `[0,${top}][200,${top + 80}]`, ...attributes });
}

class FakeAdb {
  constructor() {
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
    this.chunkIndex = 0;
    this.currentCard = null;
    this.transcriptSelected = false;
    this.qualificationArmed = null;
    this.qualificationEvidenceDigest = null;
    this.qualificationUsed = new Set();
    this.shellControlUsed = new Set();
    this.calls = [];
  }

  sleep = async (durationMs) => {
    this.nowMs += durationMs;
    if (this.capture !== 'recording') return;
    this.timer += Math.floor(durationMs / 1_000);
    this.bytesWritten += durationMs * 32;
    this.lastProgressAtMs = this.nowMs;
  };

  command = (command, args, options) => {
    assert.equal(command, adb);
    assert.deepEqual(args.slice(0, 2), ['-s', serial]);
    assert.equal(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, true);
    assert.equal(Number.isSafeInteger(options.maxOutputBytes) && options.maxOutputBytes > 0, true);
    const tail = args.slice(2);
    this.calls.push(tail);

    if (tail.join(' ') === 'shell dumpsys package com.divay.maina') {
      return result({ stdout: '  Package [com.divay.maina] (123):\n  versionCode=95 minSdk=24 targetSdk=36\n  versionName=0.10.69\n' });
    }
    if (tail.join(' ') === 'shell pm path com.divay.maina') {
      return result({ stdout: `package:${installedApkPath}\n` });
    }
    if (tail.join(' ') === `shell sha256sum ${installedApkPath}`) {
      return result({ stdout: `${syntheticArtifactSha256}  ${installedApkPath}\n` });
    }
    if (tail.join(' ') === 'exec-out uiautomator dump /dev/tty') {
      return result({ stdout: `${this.ui()}\nUI hierchary dumped to: /dev/tty\n` });
    }
    if (tail.join(' ') === 'shell dumpsys power') {
      return result({ stdout: this.power === 'on'
        ? 'Power Manager State:\n  mWakefulness=Awake\nDisplay Power: com.android.server.power.PowerManagerService$4@opaque\n'
        : 'Power Manager State:\n  mWakefulness=Asleep\nDisplay Power: com.android.server.power.PowerManagerService$4@opaque\n' });
    }
    if (tail.join(' ') === 'shell dumpsys display') {
      const state = this.power === 'on' ? 'ON' : 'OFF';
      return result({ stdout: [
        'Display States: size=1',
        '---------------------',
        '  Display Id=0',
        `  Display State=${state}`,
        '  Display Brightness=0.5',
        '  Display SdrBrightness=0.5',
        '',
        'Display Adapters: size=1',
        '',
        'Display Power Controllers: size=1',
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
        '  mStateChangeInProgress=false',
        '  mBacklightChangeInProgress=false',
      ].join('\n') });
    }
    if (tail.join(' ') === 'shell pidof com.divay.maina') {
      return this.process === 'present' ? result({ stdout: '1234\n' }) : result({ exitCode: 1 });
    }
    if (tail.join(' ') === 'shell dumpsys activity activities') {
      const component = this.screen === 'background'
        ? 'com.android.launcher3/.uioverrides.QuickstepLauncher'
        : 'com.divay.maina/.MainActivity';
      return result({ stdout: `  mResumedActivity: ActivityRecord{abc u0 ${component} t1}\n` });
    }
    if (tail.join(' ') === 'shell dumpsys activity service com.divay.maina/com.divay.maina.recorder.MainaRecordingService --maina-capture-qualification-v1') {
      return result({ stdout: [
        'SERVICE com.divay.maina/.recorder.MainaRecordingService',
        '    MAINA_CAPTURE_QUALIFICATION_V1',
        '    valid=true',
        `    nativeState=${this.capture === 'recording' ? 'recording' : this.capture === 'paused' ? 'paused' : 'idle'}`,
        `    presentationState=${this.capture}`,
        `    notificationState=${this.capture}`,
        '    clean=true',
        `    active=${this.capture === 'recording'}`,
        `    chunkIndex=${this.chunkIndex}`,
        `    bytesWritten=${this.bytesWritten}`,
        `    lastProgressAtMs=${this.lastProgressAtMs}`,
        `    qualificationSession=${this.qualificationEvidenceDigest !== null}`,
        `    qualificationEvidenceDigest=${this.qualificationEvidenceDigest ?? 'none'}`,
        '    END_MAINA_CAPTURE_QUALIFICATION_V1',
      ].join('\n') });
    }
    if (tail.join(' ') === 'shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.divay.maina/.MainActivity') {
      this.process = 'present';
      if (this.pendingRecovery) {
        this.pendingRecovery = false;
        this.capture = 'ready';
        assert.ok(this.pendingCard);
        this.pendingCard.recovery = false;
        this.visibleCards.unshift(this.pendingCard);
        this.pendingCard = null;
        this.screen = 'home';
        this.qualificationEvidenceDigest = null;
      } else if (this.capture === 'recording' || this.capture === 'paused') {
        this.screen = 'record';
      } else {
        this.screen = 'home';
      }
      return result({ stdout: privateSentinel });
    }
    if (tail.join(' ') === 'shell am start -W -a android.intent.action.VIEW -d maina:/// -n com.divay.maina/.MainActivity') {
      this.process = 'present';
      if (this.pendingRecovery) {
        this.pendingRecovery = false;
        this.capture = 'ready';
        assert.ok(this.pendingCard);
        this.pendingCard.recovery = false;
        this.visibleCards.unshift(this.pendingCard);
        this.pendingCard = null;
        this.qualificationEvidenceDigest = null;
      }
      assert.equal(this.capture, 'ready');
      this.screen = 'home';
      return result({ stdout: privateSentinel });
    }
    const armMatch = /^shell am broadcast --receiver-foreground -a com\.divay\.maina\.recorder\.SHELL_COMMAND -n com\.divay\.maina\/com\.divay\.maina\.recorder\.MainaShellCommandReceiver --es command arm_qualification --es expectedState idle --es nonce ([0-9a-f-]+)$/u.exec(tail.join(' '));
    if (armMatch) {
      const runId = armMatch[1];
      if (this.qualificationArmed !== null || this.qualificationUsed.has(runId) || this.capture !== 'ready') {
        return result({ stdout: 'Broadcast completed: result=0\n' });
      }
      this.qualificationUsed.add(runId);
      this.qualificationArmed = runId;
      return result({ stdout: `Broadcasting: Intent { act=com.divay.maina.recorder.SHELL_COMMAND }\nBroadcast completed: result=17051, data="${runId}"\n` });
    }
    const pauseMatch = /^shell am broadcast --receiver-foreground -a com\.divay\.maina\.recorder\.SHELL_COMMAND -n com\.divay\.maina\/com\.divay\.maina\.recorder\.MainaShellCommandReceiver --es command pause --es expectedState recording --es nonce ([0-9a-f-]+)$/u.exec(tail.join(' '));
    if (pauseMatch) {
      const runId = pauseMatch[1];
      if (this.shellControlUsed.has(runId) || this.capture !== 'recording') {
        return result({ stdout: 'Broadcast completed: result=0\n' });
      }
      this.shellControlUsed.add(runId);
      this.capture = 'paused';
      return result({ stdout: `Broadcasting: Intent { act=com.divay.maina.recorder.SHELL_COMMAND }\nBroadcast completed: result=17051, data="${runId}"\n` });
    }
    const launchMatch = /^shell am start -W -a android\.intent\.action\.VIEW -d maina:\/\/\/record\?qualificationRunId=([0-9a-f-]+) -n com\.divay\.maina\/\.MainActivity$/u.exec(tail.join(' '));
    if (launchMatch) {
      if (this.qualificationArmed !== launchMatch[1]) return result({ exitCode: 1 });
      this.qualificationArmed = null;
      this.qualificationEvidenceDigest = deriveQualificationEvidenceDigest(launchMatch[1]);
      this.screen = 'record';
      this.capture = 'recording';
      this.timer = 0;
      this.bytesWritten = 1;
      this.lastProgressAtMs = this.nowMs;
      this.recordingCount += 1;
      this.pendingCard = { key: `synthetic-meeting-${this.nextCard}`, recovery: false };
      this.pendingCard.metadata = `Sep 11 · 8:${String(10 + this.nextCard).padStart(2, '0')} AM · 0:20`;
      this.nextCard += 1;
      return result({ stdout: privateSentinel });
    }
    if (tail.join(' ') === 'shell input keyevent KEYCODE_HOME') {
      this.screen = 'background';
      return result();
    }
    if (tail.join(' ') === 'shell input keyevent KEYCODE_SLEEP') {
      this.power = 'off';
      return result();
    }
    if (tail.join(' ') === 'shell input keyevent KEYCODE_WAKEUP') {
      this.power = 'on';
      return result();
    }
    if (tail.join(' ') === 'shell input keyevent KEYCODE_BACK') {
      if (this.screen !== 'detail') return result({ exitCode: 1, stderr: privateSentinel });
      this.screen = 'home';
      this.currentCard = null;
      this.transcriptSelected = false;
      return result();
    }
    if (tail.join(' ') === 'shell am force-stop com.divay.maina') {
      if (this.capture === 'recording' || this.capture === 'paused') {
        this.pendingRecovery = true;
        this.capture = 'ready';
      }
      this.process = 'absent';
      this.screen = 'stopped';
      return result();
    }
    if (tail.slice(0, 3).join(' ') === 'shell input tap') {
      const [x, y] = tail.slice(3).map(Number);
      assert.equal(Number.isSafeInteger(x) && Number.isSafeInteger(y), true);
      if (this.screen === 'record' && y === 540) {
        this.capture = this.capture === 'recording' ? 'paused' : 'recording';
        return result();
      }
      if (this.screen === 'record' && y === 440) {
        this.capture = 'ready';
        this.qualificationEvidenceDigest = null;
        this.screen = 'detail';
        assert.ok(this.pendingCard);
        this.currentCard = this.pendingCard;
        this.visibleCards.unshift(this.pendingCard);
        this.pendingCard = null;
        return result();
      }
      if (this.screen === 'home' && y >= 340 && (y - 340) % 220 === 0) {
        const card = this.visibleCards[(y - 340) / 220];
        if (!card) return result({ exitCode: 1, stderr: privateSentinel });
        this.currentCard = card;
        this.transcriptSelected = false;
        this.screen = card.recovery ? 'recovery' : 'detail';
        return result();
      }
      if (this.screen === 'detail' && y === 340) {
        this.transcriptSelected = true;
        return result();
      }
      return result({ exitCode: 1, stderr: privateSentinel });
    }
    return result({ spawned: false, exitCode: null, stderr: privateSentinel });
  };

  ui() {
    if (this.screen === 'home') {
      return hierarchy(
        action('Home', 'main-tab-index', 900, { selected: 'true' }),
        action('Notifications', '', 10),
        action('Record a meeting', 'record-meeting', 1_000),
        xmlNode({ 'resource-id': 'meeting-list-loaded' }),
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
    if (this.screen === 'detail') return hierarchy(
      action('Delete meeting', 'meeting-detail-delete', 100),
      xmlNode({ text: this.currentCard?.metadata ?? '', 'resource-id': 'meeting-detail-metadata' }),
      xmlNode({ 'resource-id': `meeting-detail-correlation-${this.currentCard?.key ?? ''}` }),
      action('Transcript', 'meeting-tab-transcript', 300),
      ...(this.transcriptSelected ? [xmlNode({ text: 'No transcript · audio kept', 'resource-id': 'meeting-detail-audio-state' })] : []),
    );
    if (this.screen === 'recovery') {
      return hierarchy(
        xmlNode({ 'resource-id': 'meeting-recovery-root' }),
        xmlNode({ text: this.currentCard?.metadata ?? '', 'resource-id': 'meeting-recovery-metadata' }),
        xmlNode({ 'resource-id': `meeting-recovery-correlation-${this.currentCard?.key ?? ''}` }),
        xmlNode({ text: 'Saved audio segments: 1', 'resource-id': 'meeting-recovery-segments' }),
        xmlNode({ text: 'Audio available: Yes', 'resource-id': 'meeting-recovery-audio' }),
        action('Re-transcribe from saved audio', 'meeting-recovery-retranscribe', 500),
        action('Open saved transcript', 'meeting-recovery-open-saved', 600),
      );
    }
    if (this.screen !== 'record') throw new Error('SYNTHETIC_UI_UNAVAILABLE');
    const state = this.capture === 'paused' ? 'Paused' : 'Recording';
    const control = this.capture === 'paused' ? 'Resume' : 'Pause';
    return hierarchy(
      xmlNode({ text: `0:${String(this.timer).padStart(2, '0')}`, 'resource-id': 'recording-timer' }),
      xmlNode({ text: state, 'resource-id': 'recording-state' }),
      action('Stop and save', 'recording-stop-save', 400),
      action(control, 'recording-pause-resume', 500),
      action('Discard this recording', 'recording-discard', 600),
    );
  }
}

let assertions = 0;
function rejects(callback, code) {
  assert.throws(callback, (error) => error instanceof AndroidLifecycleAdapterFailure && error.code === code);
  assertions += 1;
}

assert.deepEqual(parseInstalledIdentity(
  '  Package [com.divay.maina] (123):\n  versionCode=95 minSdk=24 targetSdk=36\n  versionName=0.10.69\n',
), { version: '0.10.69', build: 95 });
assertions += 1;
assert.equal(parseInstalledApkPath(`package:${installedApkPath}\n`), installedApkPath);
assert.equal(parseInstalledApkSha256(`${syntheticArtifactSha256}  ${installedApkPath}\n`, installedApkPath), syntheticArtifactSha256);
assertions += 2;
rejects(() => parseInstalledApkPath(`package:${installedApkPath}\npackage:/data/app/other/base.apk\n`), 'INSTALLED_APK_PATH_OUTPUT_INVALID');
rejects(() => parseInstalledApkPath(` package:${installedApkPath}\n`), 'INSTALLED_APK_PATH_OUTPUT_INVALID');
rejects(() => parseInstalledApkPath(`package:/data/app/private path/base.apk\n`), 'INSTALLED_APK_PATH_OUTPUT_INVALID');
rejects(() => parseInstalledApkSha256(`${syntheticArtifactSha256}  /data/app/other/base.apk\n`, installedApkPath), 'INSTALLED_APK_SHA256_OUTPUT_INVALID');
rejects(() => parseInstalledApkSha256(`${syntheticArtifactSha256.toUpperCase()}  ${installedApkPath}\n`, installedApkPath), 'INSTALLED_APK_SHA256_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (123):\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina.evil] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (123):\n  versionCode=95\n  versionCode=96\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (123):\r\n  versionCode=95 minSdk=24 targetSdk=36\r\n  versionCode=96 minSdk=24 targetSdk=36\r\n  versionName=0.10.69\r\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (123):\n  versionCode=95\n  versionName=0.10.69\n  versionName=0.10.70\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina\n.evil] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('Package [com.divay.maina] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity(' Package [com.divay.maina] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('   Package [com.divay.maina] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('\t\tPackage [com.divay.maina] (123):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (xyz):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
rejects(() => parseInstalledIdentity('  Package [com.divay.maina] (123):\n  Package [com.divay.maina] (456):\n  versionCode=95\n  versionName=0.10.69\n'), 'INSTALLED_IDENTITY_OUTPUT_INVALID');
assert.deepEqual(parseInstalledIdentity(
  '  Package [com.divay.maina] (123):\n\n\tversionCode=95 minSdk=24 targetSdk=36\n\tversionName=0.10.69\n',
), { version: '0.10.69', build: 95 });
assertions += 1;

const exactHierarchy = hierarchy(xmlNode({ text: 'Resume', 'resource-id': 'recording-pause-resume', clickable: 'true' }));
assert.equal(parseUiHierarchyCommandOutput(`${exactHierarchy}\nUI hierchary dumped to: /dev/tty\n`).length, 1);
assertions += 1;
rejects(() => parseUiHierarchyCommandOutput(`${privateSentinel}\n${exactHierarchy}`), 'UI_HIERARCHY_OUTPUT_INVALID');
rejects(() => parseUiHierarchyCommandOutput(`${exactHierarchy}${exactHierarchy}`), 'UI_HIERARCHY_OUTPUT_INVALID');
rejects(() => parseUiHierarchyCommandOutput('ERROR: could not get idle state.\n'), 'UI_HIERARCHY_IDLE_TIMEOUT');

const captureDump = [
  'system wrapper line',
  'MAINA_CAPTURE_QUALIFICATION_V1',
  'valid=true',
  'nativeState=recording',
  'presentationState=recording',
  'notificationState=recording',
  'clean=true',
  'active=true',
  'chunkIndex=0',
  'bytesWritten=4096',
  'lastProgressAtMs=8192',
  'qualificationSession=true',
  `qualificationEvidenceDigest=${'b'.repeat(64)}`,
  'END_MAINA_CAPTURE_QUALIFICATION_V1',
].join('\n');
const expectedCaptureDump = {
  nativeState: 'recording',
  presentationState: 'recording',
  notificationState: 'recording',
  clean: true,
  active: true,
  chunkIndex: 0,
  bytesWritten: 4096,
  lastProgressAtMs: 8192,
  qualificationSession: true,
  qualificationEvidenceDigest: 'b'.repeat(64),
};
assert.deepEqual(parseCaptureQualificationDump(captureDump), expectedCaptureDump);
const captureEnvelope = captureDump.split('\n').slice(1);
const captureDumpWithFourSpacePrefix = [
  'system wrapper line',
  ...captureEnvelope.map((line) => `    ${line}`),
].join('\n');
assert.deepEqual(parseCaptureQualificationDump(captureDumpWithFourSpacePrefix), expectedCaptureDump);
assertions += 2;
for (const prefix of [' ', '  ', '   ', '     ', '\t']) {
  rejects(() => parseCaptureQualificationDump([
    'system wrapper line',
    ...captureEnvelope.map((line) => `${prefix}${line}`),
  ].join('\n')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
}
rejects(() => parseCaptureQualificationDump(captureDumpWithFourSpacePrefix.replace('    bytesWritten=4096', 'bytesWritten=4096')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDumpWithFourSpacePrefix.replace('    END_MAINA_CAPTURE_QUALIFICATION_V1', 'END_MAINA_CAPTURE_QUALIFICATION_V1')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDump.replace('valid=true', 'valid=false')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDump.replace('notificationState=recording', 'notificationState=paused')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(`${captureDump}\n${captureDump}`), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDump.replace('bytesWritten=4096', `bytesWritten=4096\n${privateSentinel}`)), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDump.replace('qualificationSession=true', 'qualificationSession=false')), 'NATIVE_PROGRESS_OUTPUT_INVALID');
rejects(() => parseCaptureQualificationDump(captureDump.replace(`qualificationEvidenceDigest=${'b'.repeat(64)}`, 'qualificationEvidenceDigest=none')), 'NATIVE_PROGRESS_OUTPUT_INVALID');

assert.equal(parseProcessState(result({ stdout: '1234 5678\n' })), 'present');
assert.equal(parseProcessState(result({ exitCode: 1 })), 'absent');
assertions += 2;
rejects(() => parseProcessState(result({ exitCode: 1, stderr: privateSentinel })), 'PROCESS_OUTPUT_INVALID');
rejects(() => parseProcessState(result({ stdout: '0\n' })), 'PROCESS_OUTPUT_INVALID');
rejects(() => parseProcessState({ ...result({ stdout: '1234\n' }), extra: true }), 'ADB_COMMAND_RESULT_INVALID');

assert.equal(parseForegroundState(' mResumedActivity: ActivityRecord{abc u0 com.divay.maina/.MainActivity t1}\n'), 'foreground');
assert.equal(parseForegroundState(' topResumedActivity=ActivityRecord{abc u0 com.android.launcher3/.Launcher t1}\n'), 'background');
assertions += 2;
rejects(() => parseForegroundState(''), 'FOREGROUND_OUTPUT_INVALID');
rejects(() => parseForegroundState(' mResumedActivity: ActivityRecord{a u0 com.divay.maina/.MainActivity t1}\n mResumedActivity: ActivityRecord{b u0 other/.Main t2}\n'), 'FOREGROUND_OUTPUT_INVALID');

const fake = new FakeAdb();
const tools = createAndroidLifecycleAdbTools({
  adb,
  serial,
  qualificationRunId,
  run: fake.command,
  now: () => fake.nowMs,
  sleep: fake.sleep,
});
const scenario = await executeAndroidLifecycleScenario({
  expectedVersion: '0.10.69',
  expectedBuild: 95,
  localMeetingCreatorExclusive: true,
  meetingListNewestFirst: true,
  expectedArtifactSha256: syntheticArtifactSha256,
}, tools);
assert.equal(scenario.status, 'passed', scenario.reasonCode ?? 'UNKNOWN_SCENARIO_FAILURE');
assert.deepEqual(scenario.tests.map(({ id }) => id), androidLifecycleScenarioPolicy.expectedTestIds);
assert.equal(JSON.stringify(scenario).includes(privateSentinel), false);
assert.equal(scenario.mutations.every(({ attempts }) => attempts === 1), true);
assert.equal(fake.calls.some((tail) => tail.join(' ') === 'shell dumpsys activity service com.divay.maina/com.divay.maina.recorder.MainaRecordingService --maina-capture-qualification-v1'), true);
assert.equal(fake.calls.filter((tail) => tail.join(' ') === 'shell pm path com.divay.maina').length, 1);
assert.equal(fake.calls.filter((tail) => tail.join(' ') === `shell sha256sum ${installedApkPath}`).length, 1);
assert.equal(fake.calls.some((tail) => tail.join(' ') === 'shell dumpsys notification --noredact'), false);
assert.equal(fake.calls.some((tail) => tail.join(' ') === 'exec-out uiautomator dump /dev/tty'), true);
assert.equal(fake.calls.some((tail) => /(?:uninstall|\binstall\b|pm clear|reset)/u.test(tail.join(' '))), false);
assert.equal(fake.calls.filter((tail) => tail.join(' ') === 'shell am start -W -a android.intent.action.VIEW -d maina:/// -n com.divay.maina/.MainActivity').length, 3);
const powerCommandCount = fake.calls.filter((tail) => tail.join(' ') === 'shell dumpsys power').length;
const displayCommandCount = fake.calls.filter((tail) => tail.join(' ') === 'shell dumpsys display').length;
assert.equal(powerCommandCount >= 3, true);
assert.equal(displayCommandCount, powerCommandCount);
assert.equal(fake.calls.filter((tail) => tail.includes('arm_qualification')).length, 2);
const armedIds = fake.calls
  .filter((tail) => tail.includes('arm_qualification'))
  .map((tail) => tail.at(-1));
assert.equal(new Set(armedIds).size, 2);
assert.deepEqual(armedIds, [
  deriveQualificationRecordingRunId(qualificationRunId, 'normal'),
  deriveQualificationRecordingRunId(qualificationRunId, 'recovery'),
]);
const normalQualificationRunId = deriveQualificationRecordingRunId(qualificationRunId, 'normal');
const pauseQualificationCalls = fake.calls.filter((tail) => tail.includes('pause'));
assert.equal(pauseQualificationCalls.length, 1);
assert.deepEqual(pauseQualificationCalls[0], [
  'shell', 'am', 'broadcast', '--receiver-foreground',
  '-a', 'com.divay.maina.recorder.SHELL_COMMAND',
  '-n', 'com.divay.maina/com.divay.maina.recorder.MainaShellCommandReceiver',
  '--es', 'command', 'pause',
  '--es', 'expectedState', 'recording',
  '--es', 'nonce', normalQualificationRunId,
]);
assertions += 18;

await assert.rejects(
  () => tools.performMutation({ action: 'arm_qualification', payload: { qualificationRunId: armedIds[0] } }),
  (error) => error instanceof AndroidLifecycleAdapterFailure && error.code === 'QUALIFICATION_ARM_OUTPUT_INVALID',
);
assertions += 1;

const unarmedFake = new FakeAdb();
const unarmedTools = createAndroidLifecycleAdbTools({ adb, serial, qualificationRunId, run: unarmedFake.command });
assert.equal((await unarmedTools.performMutation({
  action: 'launch_record_qualification',
  payload: { qualificationRunId },
})).exitCode, 1);
assert.equal(unarmedFake.capture, 'ready');
assertions += 2;

const malformedArmTools = createAndroidLifecycleAdbTools({
  adb,
  serial,
  qualificationRunId,
  run: () => result({ stdout: 'Broadcast completed: result=0\n' }),
});
await assert.rejects(
  () => malformedArmTools.performMutation({ action: 'arm_qualification', payload: { qualificationRunId } }),
  (error) => error instanceof AndroidLifecycleAdapterFailure && error.code === 'QUALIFICATION_ARM_OUTPUT_INVALID',
);
await assert.rejects(
  () => malformedArmTools.performMutation({ action: 'pause_qualification', payload: { qualificationRunId } }),
  (error) => error instanceof AndroidLifecycleAdapterFailure && error.code === 'QUALIFICATION_ARM_OUTPUT_INVALID',
);
assertions += 2;

const mutationCalls = [];
const timeoutTools = createAndroidLifecycleAdbTools({
  adb,
  serial,
  qualificationRunId,
  run: (command, args) => {
    mutationCalls.push({ command, args });
    return result({ exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: privateSentinel, stderr: privateSentinel });
  },
});
assert.deepEqual(await timeoutTools.performMutation({ action: 'tap', payload: { x: 10, y: 20 } }), {
  spawned: true,
  exitCode: null,
  signal: 'SIGTERM',
  timedOut: true,
});
assert.deepEqual(mutationCalls[0].args, ['-s', serial, 'shell', 'input', 'tap', '10', '20']);
assert.equal(JSON.stringify(await timeoutTools.performMutation({ action: 'press_home', payload: {} })).includes(privateSentinel), false);
assertions += 3;

const truncatedTools = createAndroidLifecycleAdbTools({
  adb,
  serial,
  qualificationRunId,
  run: () => result({ exitCode: null, outputTruncated: true, stdout: privateSentinel }),
});
assert.equal((await truncatedTools.performMutation({ action: 'press_back', payload: {} })).timedOut, true);
assertions += 1;
await assert.rejects(() => truncatedTools.installedIdentity(), (error) => (
  error instanceof AndroidLifecycleAdapterFailure && error.code === 'INSTALLED_IDENTITY_COMMAND_FAILED'
));
assertions += 1;

rejects(() => createAndroidLifecycleAdbTools({ adb: 'relative/adb', serial, run: () => result() }), 'ADAPTER_CONFIGURATION_INVALID');
rejects(() => createAndroidLifecycleAdbTools({ adb, serial, packageName: 'com.divay.maina.evil', run: () => result() }), 'ADAPTER_CONFIGURATION_INVALID');
const invalidMutationTools = createAndroidLifecycleAdbTools({ adb, serial, qualificationRunId, run: () => result() });
await assert.rejects(() => invalidMutationTools.performMutation({ action: 'uninstall', payload: {} }), (error) => (
  error instanceof AndroidLifecycleAdapterFailure && error.code === 'MUTATION_ACTION_REJECTED'
));
await assert.rejects(() => invalidMutationTools.performMutation({ action: 'tap', payload: { x: 1, y: 2, extra: 3 } }), (error) => (
  error instanceof AndroidLifecycleAdapterFailure && error.code === 'MUTATION_PAYLOAD_INVALID'
));
assertions += 2;

assert.equal(androidLifecycleAdapterPolicy.rawCommandOutputPersistenceAllowed, false);
assert.equal(androidLifecycleAdapterPolicy.automaticCommandRetryAllowed, false);
assertions += 2;

console.log(`Android lifecycle ADB adapter verified (${assertions} command-boundary and end-to-end assertions).`);
