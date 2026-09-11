import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import {
  classifyPowerState,
  parseUiAutomatorHierarchy,
} from './android-lifecycle-core.mjs';

const PACKAGE_NAME = 'com.divay.maina';
const MAIN_ACTIVITY = `${PACKAGE_NAME}/.MainActivity`;
const RECORDING_SERVICE = `${PACKAGE_NAME}/com.divay.maina.recorder.MainaRecordingService`;
const RECORDING_SERVICE_DUMP_ARG = '--maina-capture-qualification-v1';
const MAX_SMALL_OUTPUT_BYTES = 256 * 1024;
const MAX_HIERARCHY_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class AndroidLifecycleAdapterFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'AndroidLifecycleAdapterFailure';
    this.code = code;
  }
}

function fail(code) {
  throw new AndroidLifecycleAdapterFailure(code);
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function boundedText(value, limit) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit;
}

function validateCommandResult(value, maxOutputBytes) {
  if (!exactKeys(value, ['spawned', 'exitCode', 'signal', 'timedOut', 'outputTruncated', 'stdout', 'stderr'])
    || typeof value.spawned !== 'boolean'
    || (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255))
    || (value.signal !== null && (typeof value.signal !== 'string' || !/^[A-Z0-9]+$/u.test(value.signal)))
    || typeof value.timedOut !== 'boolean'
    || typeof value.outputTruncated !== 'boolean'
    || !boundedText(value.stdout, maxOutputBytes)
    || !boundedText(value.stderr, maxOutputBytes)) {
    fail('ADB_COMMAND_RESULT_INVALID');
  }
  return value;
}

function defaultRun(command, args, { timeoutMs, maxOutputBytes }) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    windowsHide: true,
  });
  const errorCode = typeof result.error?.code === 'string' ? result.error.code : null;
  return Object.freeze({
    spawned: Number.isSafeInteger(result.pid) && result.pid > 0,
    exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    signal: typeof result.signal === 'string' ? result.signal : null,
    timedOut: errorCode === 'ETIMEDOUT',
    outputTruncated: errorCode === 'ENOBUFS',
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  });
}

function exactNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(label);
  return value;
}

export function parseInstalledIdentity(output, packageName = PACKAGE_NAME) {
  if (typeof output !== 'string' || !/^[a-z][a-z0-9_.]{2,200}$/u.test(packageName)) fail('PACKAGE_IDENTITY_INVALID');
  const escapedPackage = escapeRegex(packageName);
  const packageHeaders = output.match(new RegExp(`^Package \\[${escapedPackage}\\] \\([^)\\r\\n]+\\):$`, 'gmu')) ?? [];
  const versionNames = [...output.matchAll(/^[\t ]*versionName=([^\t \r\n]+)[\t ]*$/gmu)].map((match) => match[1]);
  const versionCodes = [...output.matchAll(/^[\t ]*versionCode=([0-9]+)(?:[\t ]+[^\r\n]*)?$/gmu)].map((match) => Number(match[1]));
  if (packageHeaders.length !== 1 || versionNames.length !== 1 || versionCodes.length !== 1
    || !/^\d+\.\d+\.\d+$/u.test(versionNames[0])
    || !Number.isSafeInteger(versionCodes[0]) || versionCodes[0] < 1) {
    fail('INSTALLED_IDENTITY_OUTPUT_INVALID');
  }
  return Object.freeze({ version: versionNames[0], build: versionCodes[0] });
}

export function parseInstalledApkPath(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_SMALL_OUTPUT_BYTES) {
    fail('INSTALLED_APK_PATH_OUTPUT_INVALID');
  }
  const lines = output.replace(/\r\n/gu, '\n').split('\n').filter(Boolean);
  if (lines.length !== 1 || !/^package:\/[A-Za-z0-9._+~=\/-]+\/base\.apk$/u.test(lines[0])) {
    fail('INSTALLED_APK_PATH_OUTPUT_INVALID');
  }
  return lines[0].slice('package:'.length);
}

export function parseInstalledApkSha256(output, expectedPath) {
  if (typeof output !== 'string' || typeof expectedPath !== 'string'
    || !/^\/[A-Za-z0-9._+~=\/-]+\/base\.apk$/u.test(expectedPath)
    || Buffer.byteLength(output, 'utf8') > MAX_SMALL_OUTPUT_BYTES) {
    fail('INSTALLED_APK_SHA256_OUTPUT_INVALID');
  }
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n?$/u.exec(output);
  if (!match || match[2] !== expectedPath) fail('INSTALLED_APK_SHA256_OUTPUT_INVALID');
  return match[1];
}

export function parseUiHierarchyCommandOutput(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_HIERARCHY_OUTPUT_BYTES) {
    fail('UI_HIERARCHY_OUTPUT_INVALID');
  }
  const start = output.indexOf('<?xml');
  const endToken = '</hierarchy>';
  const end = output.indexOf(endToken);
  if (start < 0 || end < start || output.indexOf('<?xml', start + 1) >= 0 || output.indexOf(endToken, end + 1) >= 0) {
    fail('UI_HIERARCHY_OUTPUT_INVALID');
  }
  const outside = `${output.slice(0, start)}\n${output.slice(end + endToken.length)}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (outside.length > 1 || (outside.length === 1 && !/^UI hier(?:archy|chary) dumped to: \/dev\/tty$/u.test(outside[0]))) {
    fail('UI_HIERARCHY_OUTPUT_INVALID');
  }
  return parseUiAutomatorHierarchy(output.slice(start, end + endToken.length));
}

export function parseCaptureQualificationDump(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_SMALL_OUTPUT_BYTES) {
    fail('NATIVE_PROGRESS_OUTPUT_INVALID');
  }
  const lines = output.replace(/\r\n/gu, '\n').split('\n');
  const beginIndexes = lines.flatMap((line, index) => line === 'MAINA_CAPTURE_QUALIFICATION_V1' ? [index] : []);
  const endIndexes = lines.flatMap((line, index) => line === 'END_MAINA_CAPTURE_QUALIFICATION_V1' ? [index] : []);
  if (beginIndexes.length !== 1 || endIndexes.length !== 1 || endIndexes[0] !== beginIndexes[0] + 12) {
    fail('NATIVE_PROGRESS_OUTPUT_INVALID');
  }
  const body = lines.slice(beginIndexes[0] + 1, endIndexes[0]);
  const match = /^valid=(true|false)\nnativeState=(idle|ownership_pending|paused|recording|error)\npresentationState=(ready|recording|paused|saving)\nnotificationState=(ready|recording|paused|saving)\nclean=(true|false)\nactive=(true|false)\nchunkIndex=([0-9]+)\nbytesWritten=([0-9]+)\nlastProgressAtMs=([0-9]+)\nqualificationSession=(true|false)\nqualificationEvidenceDigest=(none|[0-9a-f]{64})$/u.exec(body.join('\n'));
  if (!match || match[1] !== 'true' || match[4] !== match[3]) fail('NATIVE_PROGRESS_OUTPUT_INVALID');
  const chunkIndex = Number(match[7]);
  const bytesWritten = Number(match[8]);
  const lastProgressAtMs = Number(match[9]);
  const qualificationSession = match[10] === 'true';
  const qualificationEvidenceDigest = match[11] === 'none' ? null : match[11];
  exactNonnegativeInteger(chunkIndex, 'NATIVE_PROGRESS_OUTPUT_INVALID');
  exactNonnegativeInteger(bytesWritten, 'NATIVE_PROGRESS_OUTPUT_INVALID');
  exactNonnegativeInteger(lastProgressAtMs, 'NATIVE_PROGRESS_OUTPUT_INVALID');
  if (qualificationSession !== (qualificationEvidenceDigest !== null)) fail('NATIVE_PROGRESS_OUTPUT_INVALID');
  return Object.freeze({
    nativeState: match[2],
    presentationState: match[3],
    notificationState: match[4],
    clean: match[5] === 'true',
    active: match[6] === 'true',
    chunkIndex,
    bytesWritten,
    lastProgressAtMs,
    qualificationSession,
    qualificationEvidenceDigest,
  });
}

export function parseProcessState(result) {
  validateCommandResult(result, MAX_SMALL_OUTPUT_BYTES);
  if (!result.spawned || result.signal !== null || result.timedOut || result.outputTruncated) fail('PROCESS_OUTPUT_INVALID');
  if (result.exitCode === 1 && result.stdout === '' && result.stderr === '') return 'absent';
  if (result.exitCode !== 0 || result.stderr !== '' || !/^[1-9]\d*(?: [1-9]\d*)*\r?\n?$/u.test(result.stdout)) {
    fail('PROCESS_OUTPUT_INVALID');
  }
  return 'present';
}

export function parseForegroundState(output, packageName = PACKAGE_NAME) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_SMALL_OUTPUT_BYTES) fail('FOREGROUND_OUTPUT_INVALID');
  const resumed = output.split(/\r?\n/u).filter((line) => /^\s*(?:mResumedActivity:|topResumedActivity=)\s*ActivityRecord\{/u.test(line));
  if (resumed.length !== 1) fail('FOREGROUND_OUTPUT_INVALID');
  const exactComponent = new RegExp(`(?:^|\\s)${escapeRegex(packageName)}\\/(?:\\.MainActivity|${escapeRegex(packageName)}\\.MainActivity)(?:\\s|\\})`, 'u');
  return exactComponent.test(resumed[0]) ? 'foreground' : 'background';
}

function commandSucceeded(result) {
  return result.spawned && result.exitCode === 0 && result.signal === null && !result.timedOut && !result.outputTruncated;
}

function mutationCommand(action, payload, packageName) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('MUTATION_PAYLOAD_INVALID');
  if (action === 'tap') {
    if (!exactKeys(payload, ['x', 'y'])) fail('MUTATION_PAYLOAD_INVALID');
    const x = exactNonnegativeInteger(payload.x, 'MUTATION_PAYLOAD_INVALID');
    const y = exactNonnegativeInteger(payload.y, 'MUTATION_PAYLOAD_INVALID');
    if (x > 10_000 || y > 10_000) fail('MUTATION_PAYLOAD_INVALID');
    return ['shell', 'input', 'tap', String(x), String(y)];
  }
  if (action === 'arm_qualification' || action === 'launch_record_qualification') {
    if (!exactKeys(payload, ['qualificationRunId'])
      || typeof payload.qualificationRunId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(payload.qualificationRunId)) {
      fail('MUTATION_PAYLOAD_INVALID');
    }
    if (action === 'arm_qualification') return [
      'shell', 'am', 'broadcast', '--receiver-foreground',
      '-a', 'com.divay.maina.recorder.SHELL_COMMAND',
      '-n', `${packageName}/com.divay.maina.recorder.MainaShellCommandReceiver`,
      '--es', 'command', 'arm_qualification',
      '--es', 'expectedState', 'idle',
      '--es', 'nonce', payload.qualificationRunId.toLowerCase(),
    ];
    return [
      'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
      '-d', `maina:///record?qualificationRunId=${payload.qualificationRunId.toLowerCase()}`,
      '-n', MAIN_ACTIVITY,
    ];
  }
  if (!exactKeys(payload, [])) fail('MUTATION_PAYLOAD_INVALID');
  const commands = {
    force_stop: ['shell', 'am', 'force-stop', packageName],
    launch_main: ['shell', 'am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-n', MAIN_ACTIVITY],
    press_back: ['shell', 'input', 'keyevent', 'KEYCODE_BACK'],
    press_home: ['shell', 'input', 'keyevent', 'KEYCODE_HOME'],
    sleep_device: ['shell', 'input', 'keyevent', 'KEYCODE_SLEEP'],
    wake_up: ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
  };
  if (!Object.hasOwn(commands, action)) fail('MUTATION_ACTION_REJECTED');
  return commands[action];
}

export function createAndroidLifecycleAdbTools({
  adb,
  serial,
  qualificationRunId,
  packageName = PACKAGE_NAME,
  run = defaultRun,
  now = Date.now,
  sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  recordMutationState,
}) {
  if (typeof adb !== 'string' || !isAbsolute(adb) || typeof serial !== 'string'
    || !/^[A-Za-z0-9._:-]{1,255}$/u.test(serial) || packageName !== PACKAGE_NAME
    || typeof qualificationRunId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(qualificationRunId)
    || typeof run !== 'function' || typeof now !== 'function' || typeof sleep !== 'function'
    || (recordMutationState !== undefined && typeof recordMutationState !== 'function')) {
    fail('ADAPTER_CONFIGURATION_INVALID');
  }

  const execute = (tail, { timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_SMALL_OUTPUT_BYTES } = {}) => validateCommandResult(
    run(adb, ['-s', serial, ...tail], { timeoutMs, maxOutputBytes }),
    maxOutputBytes,
  );
  const read = (tail, code, options) => {
    const result = execute(tail, options);
    if (!commandSucceeded(result)) fail(code);
    return result.stdout;
  };

  return Object.freeze({
    now,
    sleep,
    qualificationRunId: qualificationRunId.toLowerCase(),
    ...(recordMutationState ? { recordMutationState } : {}),
    installedIdentity: async () => parseInstalledIdentity(read(
      ['shell', 'dumpsys', 'package', packageName],
      'INSTALLED_IDENTITY_COMMAND_FAILED',
    ), packageName),
    installedArtifactSha256: async () => {
      const path = parseInstalledApkPath(read(
        ['shell', 'pm', 'path', packageName],
        'INSTALLED_APK_PATH_COMMAND_FAILED',
      ));
      return parseInstalledApkSha256(read(
        ['shell', 'sha256sum', path],
        'INSTALLED_APK_SHA256_COMMAND_FAILED',
      ), path);
    },
    notificationState: async () => parseCaptureQualificationDump(read(
      ['shell', 'dumpsys', 'activity', 'service', RECORDING_SERVICE, RECORDING_SERVICE_DUMP_ARG],
      'PRESENTATION_STATE_COMMAND_FAILED',
    )).notificationState,
    readUiNodes: async () => parseUiHierarchyCommandOutput(read(
      ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
      'UI_HIERARCHY_COMMAND_FAILED',
      { timeoutMs: 20_000, maxOutputBytes: MAX_HIERARCHY_OUTPUT_BYTES },
    )),
    powerState: async () => classifyPowerState(read(
      ['shell', 'dumpsys', 'power'],
      'POWER_COMMAND_FAILED',
    )),
    processState: async () => parseProcessState(execute(
      ['shell', 'pidof', packageName],
    )),
    foregroundState: async () => parseForegroundState(read(
      ['shell', 'dumpsys', 'activity', 'activities'],
      'FOREGROUND_COMMAND_FAILED',
    ), packageName),
    nativeCaptureProgress: async () => parseCaptureQualificationDump(read(
      ['shell', 'dumpsys', 'activity', 'service', RECORDING_SERVICE, RECORDING_SERVICE_DUMP_ARG],
      'NATIVE_PROGRESS_COMMAND_FAILED',
    )),
    performMutation: async ({ action, payload }) => {
      const tail = mutationCommand(action, payload, packageName);
      const result = execute(tail, { timeoutMs: action === 'launch_main' ? 20_000 : DEFAULT_TIMEOUT_MS });
      if (action === 'arm_qualification' && commandSucceeded(result)) {
        const expected = `Broadcast completed: result=17051, data="${payload.qualificationRunId.toLowerCase()}"`;
        const matches = result.stdout.replace(/\r\n/gu, '\n').split('\n').filter((line) => line.trim() === expected);
        if (matches.length !== 1) fail('QUALIFICATION_ARM_OUTPUT_INVALID');
      }
      return Object.freeze({
        spawned: result.spawned,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut || result.outputTruncated,
      });
    },
  });
}

export const androidLifecycleAdapterPolicy = Object.freeze({
  schemaVersion: 'maina.android-lifecycle-adapter.v1',
  packageName: PACKAGE_NAME,
  mainActivity: MAIN_ACTIVITY,
  recordingService: RECORDING_SERVICE,
  recordingServiceDumpArg: RECORDING_SERVICE_DUMP_ARG,
  rawCommandOutputPersistenceAllowed: false,
  automaticCommandRetryAllowed: false,
});
