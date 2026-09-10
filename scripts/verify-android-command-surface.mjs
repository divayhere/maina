#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AndroidConfig } from '@expo/config-plugins';

const project = path.resolve(import.meta.dirname, '..');
const ANDROID_NAME = 'android:name';
const TOOLS_NODE = 'tools:node';
const COMMAND_RECEIVER = 'com.divay.maina.recorder.MainaCommandReceiver';
const SHELL_RECEIVER = 'com.divay.maina.recorder.MainaShellCommandReceiver';
const ACCESSIBILITY_SERVICE = 'com.divay.maina.recorder.MainaKeyAccessibilityService';
const HOSTILE_FIXTURE_SOURCE = 'scripts/fixtures/android-command-hostile/HostileReceiver.java';
const EMULATOR_VERIFIER_SOURCE = 'scripts/verify-android-command-surface-emulator.mjs';
const COMMAND_ACTIONS = [
  'com.divay.maina.action.PAUSE',
  'com.divay.maina.action.RESUME',
  'com.divay.maina.action.START',
  'com.divay.maina.action.STOP',
  'com.divay.maina.action.TOGGLE',
];
const BLOCKED_PERMISSIONS = [
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];
const RELEASE_PERMISSIONS = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROCESSING',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.INTERNET',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.RECORD_AUDIO',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'android.permission.VIBRATE',
  'android.permission.WAKE_LOCK',
  'com.divay.maina.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
];
const DEBUG_PERMISSIONS = [...RELEASE_PERMISSIONS, 'android.permission.SYSTEM_ALERT_WINDOW'];
const DYNAMIC_RECEIVER_PERMISSION = 'com.divay.maina.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} has missing or unknown keys.`);
}

function exactStringSet(actual, expected, label) {
  invariant(Array.isArray(actual), `${label} must be an array.`);
  invariant(actual.every((entry) => typeof entry === 'string' && entry.length > 0), `${label} entries must be nonempty strings.`);
  invariant(new Set(actual).size === actual.length, `${label} contains duplicate entries.`);
  invariant(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    `${label} differs from the exact allowlist.`,
  );
}

function replaceUnique(source, search, replacement) {
  invariant(source.split(search).length === 2, `Mutation anchor must occur exactly once: ${search}`);
  const mutated = source.replace(search, replacement);
  invariant(mutated !== source, `Mutation must change source: ${search}`);
  return mutated;
}

function manifestRoot(document, label) {
  exactKeys(document, ['manifest'], label);
  invariant(document.manifest && typeof document.manifest === 'object', `${label}.manifest must be an object.`);
  return document.manifest;
}

function applications(manifest, label) {
  invariant(Array.isArray(manifest.application) && manifest.application.length === 1, `${label} must contain exactly one application.`);
  return manifest.application[0];
}

function attrs(entry, expectedKeys, label) {
  exactKeys(entry, ['$'], label);
  exactKeys(entry.$, expectedKeys, `${label} attributes`);
  return entry.$;
}

function validateCommandActionOwnership(application, label, expectedCount) {
  const owners = [];
  for (const componentType of ['activity', 'activity-alias', 'receiver', 'service']) {
    const components = Array.isArray(application[componentType]) ? application[componentType] : [];
    for (const component of components) {
      const filters = Array.isArray(component?.['intent-filter']) ? component['intent-filter'] : [];
      for (const filter of filters) {
        const actions = Array.isArray(filter?.action) ? filter.action : [];
        for (const action of actions) {
          const name = action?.$?.[ANDROID_NAME];
          if (COMMAND_ACTIONS.includes(name)) {
            owners.push({ componentType, componentName: component?.$?.[ANDROID_NAME], action: name });
          }
        }
      }
    }
  }
  invariant(owners.length === expectedCount, `${label} command-action cardinality drifted.`);
  for (const owner of owners) {
    invariant(
      owner.componentType === 'receiver' && owner.componentName === COMMAND_RECEIVER,
      `${label} command action ${owner.action} belongs to an unexpected component.`,
    );
  }
  if (expectedCount > 0) exactStringSet(owners.map((owner) => owner.action), COMMAND_ACTIONS, `${label} command-action ownership`);
}

function validateCommandReceiver(application, label) {
  const receivers = Array.isArray(application.receiver) ? application.receiver : [];
  const commandReceivers = receivers.filter((entry) => entry?.$?.[ANDROID_NAME] === COMMAND_RECEIVER);
  invariant(commandReceivers.length === 1, `${label} must define exactly one Maina command receiver.`);
  const receiver = commandReceivers[0];
  exactKeys(receiver, ['$', 'intent-filter'], `${label} Maina command receiver`);
  exactKeys(receiver.$, [ANDROID_NAME, 'android:enabled', 'android:exported'], `${label} Maina command receiver attributes`);
  invariant(receiver.$['android:enabled'] === 'true', `${label} Maina command receiver must be enabled.`);
  invariant(receiver.$['android:exported'] === 'false', `${label} Maina command receiver must be non-exported.`);
  invariant(Array.isArray(receiver['intent-filter']) && receiver['intent-filter'].length === 1, `${label} Maina command receiver must have one exact intent filter.`);
  const intentFilter = receiver['intent-filter'][0];
  exactKeys(intentFilter, ['action'], `${label} Maina command receiver intent filter`);
  const actions = intentFilter.action.map((entry, index) => attrs(entry, [ANDROID_NAME], `${label} Maina command action ${index}`)[ANDROID_NAME]);
  exactStringSet(actions, COMMAND_ACTIONS, `${label} Maina command receiver actions`);
  validateCommandActionOwnership(application, label, COMMAND_ACTIONS.length);
}

function validateShellReceiver(application, label) {
  const receivers = Array.isArray(application.receiver) ? application.receiver : [];
  const matches = receivers.filter((entry) => entry?.$?.[ANDROID_NAME] === SHELL_RECEIVER);
  invariant(matches.length === 1, `${label} must define exactly one Maina shell command receiver.`);
  const receiver = matches[0];
  exactKeys(receiver, ['$'], `${label} Maina shell command receiver`);
  exactKeys(receiver.$, [ANDROID_NAME, 'android:enabled', 'android:exported', 'android:permission'], `${label} Maina shell command receiver attributes`);
  invariant(receiver.$['android:enabled'] === 'true', `${label} Maina shell command receiver must be enabled.`);
  invariant(receiver.$['android:exported'] === 'true', `${label} Maina shell command receiver must be explicitly exported to the protected shell.`);
  invariant(receiver.$['android:permission'] === 'android.permission.DUMP', `${label} Maina shell command receiver must require android.permission.DUMP.`);
}

function validateAccessibilityService(application, label, closed) {
  const services = Array.isArray(application.service) ? application.service : [];
  const matches = services.filter((entry) => entry?.$?.[ANDROID_NAME] === ACCESSIBILITY_SERVICE);
  invariant(matches.length === 1, `${label} must define exactly one Maina accessibility service.`);
  const service = matches[0];
  if (closed) {
    exactKeys(service, ['$', 'intent-filter', 'meta-data'], `${label} Maina accessibility service`);
    exactKeys(
      service.$,
      [ANDROID_NAME, 'android:enabled', 'android:exported', 'android:label', 'android:permission', 'android:process'],
      `${label} Maina accessibility service attributes`,
    );
    invariant(service.$['android:enabled'] === 'true', `${label} Maina accessibility service must be enabled.`);
    invariant(service.$['android:label'] === 'Maina remote control', `${label} Maina accessibility label drifted.`);
    invariant(service.$['android:process'] === ':remote_control', `${label} Maina accessibility process drifted.`);
    invariant(Array.isArray(service['intent-filter']) && service['intent-filter'].length === 1, `${label} Maina accessibility service must have one intent filter.`);
    exactKeys(service['intent-filter'][0], ['action'], `${label} Maina accessibility intent filter`);
    invariant(Array.isArray(service['intent-filter'][0].action) && service['intent-filter'][0].action.length === 1, `${label} Maina accessibility service must have one bind action.`);
    const action = attrs(service['intent-filter'][0].action[0], [ANDROID_NAME], `${label} Maina accessibility action`);
    invariant(action[ANDROID_NAME] === 'android.accessibilityservice.AccessibilityService', `${label} Maina accessibility action drifted.`);
    invariant(Array.isArray(service['meta-data']) && service['meta-data'].length === 1, `${label} Maina accessibility service must have one metadata record.`);
    const metadata = attrs(service['meta-data'][0], [ANDROID_NAME, 'android:resource'], `${label} Maina accessibility metadata`);
    invariant(metadata[ANDROID_NAME] === 'android.accessibilityservice', `${label} Maina accessibility metadata name drifted.`);
    invariant(metadata['android:resource'] === '@xml/maina_accessibility_service', `${label} Maina accessibility metadata resource drifted.`);
  }
  invariant(service.$['android:exported'] === 'true', `${label} Maina accessibility service must remain exported for Android binding.`);
  invariant(
    service.$['android:permission'] === 'android.permission.BIND_ACCESSIBILITY_SERVICE',
    `${label} Maina accessibility service must remain protected by BIND_ACCESSIBILITY_SERVICE.`,
  );
}

export function validateAppConfig(config) {
  invariant(config?.expo?.android && typeof config.expo.android === 'object', 'app.json must define expo.android.');
  const android = config.expo.android;
  exactStringSet(android.blockedPermissions, BLOCKED_PERMISSIONS, 'expo.android.blockedPermissions');
  invariant(Array.isArray(android.permissions), 'expo.android.permissions must be an array.');
  invariant(
    !android.permissions.some((permission) => BLOCKED_PERMISSIONS.includes(permission) || BLOCKED_PERMISSIONS.includes(`android.permission.${permission}`)),
    'A blocked Android permission is also actively requested.',
  );
}

export function validateModuleManifest(document) {
  const manifest = manifestRoot(document, 'module manifest');
  const application = applications(manifest, 'module manifest');
  validateCommandReceiver(application, 'Module manifest');
  validateShellReceiver(application, 'Module manifest');
  validateAccessibilityService(application, 'Module manifest', false);
}

export function validateGeneratedManifest(document) {
  const manifest = manifestRoot(document, 'generated app manifest');
  const permissionTags = Object.keys(manifest).filter((key) => key.startsWith('uses-permission'));
  exactStringSet(permissionTags, ['uses-permission'], 'generated app manifest permission element names');
  const permissions = Array.isArray(manifest['uses-permission']) ? manifest['uses-permission'] : [];
  for (const permission of BLOCKED_PERMISSIONS) {
    const matches = permissions.filter((entry) => entry?.$?.[ANDROID_NAME] === permission);
    invariant(matches.length === 1, `Generated app manifest must contain one removal marker for ${permission}.`);
    const permissionAttrs = attrs(matches[0], [ANDROID_NAME, TOOLS_NODE], `Generated ${permission} removal marker`);
    invariant(permissionAttrs[TOOLS_NODE] === 'remove', `Generated ${permission} declaration must be a removal marker.`);
  }
  validateCommandActionOwnership(applications(manifest, 'generated app manifest'), 'Generated app manifest', 0);
}

export function validateMergedManifest(document, variant = 'release') {
  invariant(variant === 'debug' || variant === 'release', 'Merged manifest variant is invalid.');
  const label = `${variant} merged manifest`;
  const manifest = manifestRoot(document, label);
  const permissionTags = Object.keys(manifest).filter((key) => key.startsWith('uses-permission'));
  exactStringSet(permissionTags, ['uses-permission'], `${label} permission element names`);
  const permissions = manifest['uses-permission'];
  const permissionNames = permissions.map((entry, index) => attrs(entry, [ANDROID_NAME], `${label} permission ${index}`)[ANDROID_NAME]);
  exactStringSet(permissionNames, variant === 'debug' ? DEBUG_PERMISSIONS : RELEASE_PERMISSIONS, `${label} permissions`);

  invariant(Array.isArray(manifest.permission) && manifest.permission.length === 1, `${label} must define one dynamic-receiver permission.`);
  const dynamicPermission = attrs(
    manifest.permission[0],
    [ANDROID_NAME, 'android:protectionLevel'],
    `${label} dynamic-receiver permission`,
  );
  invariant(dynamicPermission[ANDROID_NAME] === DYNAMIC_RECEIVER_PERMISSION, `${label} dynamic-receiver permission name drifted.`);
  invariant(dynamicPermission['android:protectionLevel'] === 'signature', `${label} dynamic-receiver permission must be signature-protected.`);

  const application = applications(manifest, label);
  validateCommandReceiver(application, label);
  validateShellReceiver(application, label);
  validateAccessibilityService(application, label, true);
}

export function validateTriggerSource(source) {
  invariant(
    source.includes('/** Same-UID compatibility endpoint; external control uses protected OS channels. */'),
    'Maina command receiver must document its internal-only authority.',
  );
  invariant(source.includes('MainaHardwareTrigger.emit(context, command, "internal-intent")'), 'Maina command receiver must publish an internal source.');
  invariant(!source.includes('"external-intent"'), 'Maina command receiver must not claim an external intent source.');
}

export function validateOperationalScripts(soakSource, bridgeSource) {
  for (const [label, source] of [['soak monitor', soakSource], ['button bridge', bridgeSource]]) {
    invariant(!/am\s+broadcast[\s\S]*?com\.divay\.maina\.action\./.test(source), `${label} must not invoke the removed public broadcast surface.`);
  }
  invariant(!soakSource.includes('cmd media_session dispatch') && !bridgeSource.includes('cmd media_session dispatch'), 'Operational scripts must not use the global media-session dispatcher.');
  for (const [label, source] of [['soak monitor', soakSource], ['button bridge', bridgeSource]]) {
    invariant(source.includes('com.divay.maina.recorder.MainaShellCommandReceiver'), `${label} must target the exact protected Maina shell receiver.`);
    invariant(source.includes('com.divay.maina.recorder.SHELL_COMMAND'), `${label} must use the exact protected Maina shell action.`);
    invariant(source.includes('result=17051'), `${label} must require the exact nonzero Maina acceptance sentinel.`);
    invariant(source.includes('android.permission.DUMP: granted=true'), `${label} must fail closed unless the shell holds DUMP.`);
  }
  invariant((soakSource.match(/\bsend_stop\b/g) ?? []).length === 2, 'Soak monitor must define and invoke its stop exactly once.');
  invariant(!soakSource.includes('DEVICE_STOP_LOG'), 'Soak monitor must not retain a second device-local stop path.');
  invariant(bridgeSource.includes('dispatch_maina_command toggle'), 'Button bridge must map its primary action to protected Maina toggle.');
  invariant(bridgeSource.includes('dispatch_maina_command stop'), 'Button bridge must map its secondary action to protected Maina stop.');
  invariant(bridgeSource.includes('wait_for_state_ack "$before" "$command"'), 'Button bridge must require a bounded Maina state acknowledgment.');
  invariant(bridgeSource.includes("grep -q 'MainaRecordingService'"), 'Button bridge must refuse dispatch unless Maina is armed.');
}

export function validateDynamicReceiverSources(sources) {
  invariant(sources instanceof Map && sources.size > 0, 'Android native sources must be a nonempty path map.');
  const recorderModulePath = 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt';
  const source = sources.get(recorderModulePath);
  invariant(typeof source === 'string', 'MainaRecorderModule.kt is missing from the Android native source set.');
  const combined = [...sources.entries()].map(([file, body]) => `// ${file}\n${body}`).join('\n');
  invariant(source.includes('import androidx.core.content.ContextCompat'), 'Dynamic receiver must use the AndroidX compatibility boundary.');
  invariant(
    source.includes('ContextCompat.registerReceiver(') && source.includes('ContextCompat.RECEIVER_NOT_EXPORTED'),
    'Dynamic receiver must be non-exported on every supported Android API.',
  );
  invariant(!source.includes('context.registerReceiver('), 'Dynamic receiver must not use the legacy unprotected registration overload.');
  invariant(!source.includes('Context.RECEIVER_EXPORTED'), 'Dynamic receiver must never be externally exported.');
  invariant((combined.match(/\bregisterReceiver\s*\(/g) ?? []).length === 1, 'Android native sources must contain exactly one dynamic receiver registration site.');
  for (const action of [
    'MainaHardwareTrigger.ACTION_TRIGGER',
    'MainaAudioRouteBridge.ACTION_ROUTE_CHANGED',
    'MainaPostProcessingService.ACTION_RESULT_CHANGED',
  ]) {
    invariant(source.includes(`addAction(${action})`), `Dynamic receiver filter is missing ${action}.`);
    invariant((combined.match(new RegExp(`addAction\\(${action.replaceAll('.', '\\.') }\\)`, 'g')) ?? []).length === 1, `Dynamic receiver action ${action} must have one registration owner.`);
  }
  for (const actionValue of [
    'com.divay.maina.recorder.HARDWARE_TRIGGER',
    'com.divay.maina.recorder.AUDIO_ROUTE_CHANGED',
    'com.divay.maina.recorder.NATIVE_POST_PROCESSING_CHANGED',
  ]) invariant(combined.split(`"${actionValue}"`).length === 2, `Dynamic receiver action value ${actionValue} must have one source declaration.`);
}

export function validateHostileFixtureSource(source) {
  invariant(typeof source === 'string' && source.length > 0, 'Hostile emulator fixture source must be nonempty.');
  for (const token of [
    'com.divay.maina.recorder.MainaCommandReceiver',
    'com.divay.maina.recorder.MainaShellCommandReceiver',
    'com.divay.maina.recorder.HARDWARE_TRIGGER',
    'com.divay.maina.recorder.SHELL_COMMAND',
  ]) invariant(source.includes(`"${token}"`), `Hostile emulator fixture is missing ${token}.`);
  invariant(!source.includes('android.permission.DUMP'), 'Hostile emulator fixture must not request or claim the protected shell permission.');
}

export function runHostileFixtureMutationCorpus(source) {
  const cases = [];
  for (const token of [
    'com.divay.maina.recorder.MainaCommandReceiver',
    'com.divay.maina.recorder.MainaShellCommandReceiver',
    'com.divay.maina.recorder.HARDWARE_TRIGGER',
    'com.divay.maina.recorder.SHELL_COMMAND',
  ]) {
    expectReject(`hostile fixture missing ${token}`, () => validateHostileFixtureSource(source.replace(token, 'removed')));
    cases.push(`hostile fixture missing ${token}`);
  }
  expectReject('hostile fixture claims DUMP', () => validateHostileFixtureSource(`${source}\n// android.permission.DUMP`));
  cases.push('hostile fixture claims DUMP');
  return cases;
}

export function validateEmulatorVerifierSource(source) {
  invariant(typeof source === 'string' && source.length > 0, 'Emulator verifier source must be nonempty.');
  const uniqueClauses = [
    "schemaVersion: '2'",
    'const [serial, apiText, mainaApkArg, expectedMainaApkSha256, evidenceRootArg]',
    "if (!/^[a-f0-9]{64}$/.test(expectedMainaApkSha256 ?? '')) fail('ARGUMENT_INVALID');",
    "const stagedMainaApk = join(workRoot, 'maina.apk');",
    'copyFileSync(mainaApk, stagedMainaApk, fsConstants.COPYFILE_EXCL);',
    'const actualMainaApkSha256 = await sha256File(stagedMainaApk);',
    "if (actualMainaApkSha256 !== expectedMainaApkSha256) fail('MAINA_APK_SHA256_MISMATCH');",
    'mainaApkSha256: null',
    'mainaApkStagedPrivate: false',
    "['dump', 'badging', stagedMainaApk]",
    "['verify', '--print-certs', stagedMainaApk]",
    "['install', '-r', stagedMainaApk]",
    'const hostileIdleStabilityMs = 30_000',
    "adbRun(['shell', 'am', 'wait-for-broadcast-idle']",
    'broadcastIdleBarriers: 0',
    'result.preShellIdleStabilityMs = hostileIdleStabilityMs',
  ];
  for (const token of uniqueClauses) {
    invariant(source.split(token).length === 2, `Emulator verifier must contain one exact ${token}.`);
  }
  invariant(
    (source.match(/requireStableState\('idle', hostileIdleStabilityMs\)/g) ?? []).length === 2,
    'Emulator verifier must prove idle stability after every hostile attempt and again before shell control.',
  );
  invariant(
    (source.match(/waitForBroadcastIdle\(\);/g) ?? []).length === 2,
    'Emulator verifier must drain broadcasts after every hostile attempt and again before shell control.',
  );
  invariant(
    source.indexOf('result.preShellIdleStabilityMs = hostileIdleStabilityMs') < source.indexOf("shellCommand('start'"),
    'Emulator verifier must establish pre-shell idle stability before the legitimate command.',
  );
  invariant(
    source.indexOf("if (actualMainaApkSha256 !== expectedMainaApkSha256) fail('MAINA_APK_SHA256_MISMATCH');")
      < source.indexOf("const qemu = adbRun("),
    'Emulator verifier must bind the staged APK digest before its first device command.',
  );
}

export function runEmulatorVerifierMutationCorpus(source) {
  const cases = [];
  for (const [label, token] of [
    ['schema version', "schemaVersion: '2'"],
    ['expected digest argument', 'const [serial, apiText, mainaApkArg, expectedMainaApkSha256, evidenceRootArg]'],
    ['digest shape check', "if (!/^[a-f0-9]{64}$/.test(expectedMainaApkSha256 ?? '')) fail('ARGUMENT_INVALID');"],
    ['private staged copy', 'copyFileSync(mainaApk, stagedMainaApk, fsConstants.COPYFILE_EXCL);'],
    ['staged digest', 'const actualMainaApkSha256 = await sha256File(stagedMainaApk);'],
    ['digest equality', "if (actualMainaApkSha256 !== expectedMainaApkSha256) fail('MAINA_APK_SHA256_MISMATCH');"],
    ['receipt digest', 'mainaApkSha256: null'],
    ['private-stage receipt', 'mainaApkStagedPrivate: false'],
    ['staged badging consumer', "['dump', 'badging', stagedMainaApk]"],
    ['staged signer consumer', "['verify', '--print-certs', stagedMainaApk]"],
    ['staged install consumer', "['install', '-r', stagedMainaApk]"],
    ['idle horizon', 'const hostileIdleStabilityMs = 30_000'],
    ['broadcast barrier command', "adbRun(['shell', 'am', 'wait-for-broadcast-idle']"],
    ['broadcast barrier receipt', 'broadcastIdleBarriers: 0'],
    ['pre-shell stability receipt', 'result.preShellIdleStabilityMs = hostileIdleStabilityMs'],
  ]) {
    expectReject(`emulator verifier missing ${label}`, () => validateEmulatorVerifierSource(replaceUnique(source, token, 'removed')));
    cases.push(`emulator verifier missing ${label}`);
  }
  expectReject(
    'emulator verifier missing hostile stability pass',
    () => validateEmulatorVerifierSource(source.replace("requireStableState('idle', hostileIdleStabilityMs);", "waitForState('idle', 1);")),
  );
  cases.push('emulator verifier missing hostile stability pass');
  return cases;
}

function readNativeReceiverSources() {
  const sources = new Map();
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.kt', '*.java'], {
    cwd: project,
    encoding: 'utf8',
  }).split('\n').filter(Boolean);
  for (const relative of listed) {
    if (relative === HOSTILE_FIXTURE_SOURCE) continue;
    sources.set(relative, readFileSync(path.join(project, relative), 'utf8'));
  }
  return sources;
}

function clone(value) {
  return structuredClone(value);
}

function syntheticGeneratedManifest() {
  return {
    manifest: {
      'uses-permission': BLOCKED_PERMISSIONS.map((permission) => ({
        $: { [ANDROID_NAME]: permission, [TOOLS_NODE]: 'remove' },
      })),
      application: [{}],
    },
  };
}

function syntheticMergedManifest(moduleManifest, variant) {
  const application = moduleManifest.manifest.application[0];
  const receiver = application.receiver.find((entry) => entry.$[ANDROID_NAME] === COMMAND_RECEIVER);
  const shellReceiver = application.receiver.find((entry) => entry.$[ANDROID_NAME] === SHELL_RECEIVER);
  const accessibility = application.service.find((entry) => entry.$[ANDROID_NAME] === ACCESSIBILITY_SERVICE);
  return {
    manifest: {
      'uses-permission': (variant === 'debug' ? DEBUG_PERMISSIONS : RELEASE_PERMISSIONS).map((permission) => ({
        $: { [ANDROID_NAME]: permission },
      })),
      permission: [{
        $: {
          [ANDROID_NAME]: DYNAMIC_RECEIVER_PERMISSION,
          'android:protectionLevel': 'signature',
        },
      }],
      application: [{
        receiver: [clone(receiver), clone(shellReceiver)],
        service: [clone(accessibility)],
      }],
    },
  };
}

function ordered(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    invariant(next > cursor, `${label} ordering/invariant missing: ${token}`);
    cursor = next;
  }
}

export function validateReleaseVerifierSource(source) {
  const debugPath = 'DEBUG_MANIFEST="$MAINA_ANDROID_OUTPUT_ROOT/_app/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml"';
  const releasePath = 'RELEASE_MANIFEST="$MAINA_ANDROID_OUTPUT_ROOT/_app/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml"';
  ordered(source, [
    ':app:processReleaseMainManifest',
    debugPath,
    '[[ ! -f "$DEBUG_MANIFEST" || -L "$DEBUG_MANIFEST" ]]',
    releasePath,
    '[[ ! -f "$RELEASE_MANIFEST" || -L "$RELEASE_MANIFEST" ]]',
    '"$MAINA_NODE_BIN/node" "$PROJECT_DIR/scripts/verify-android-command-surface.mjs"',
    '--generated-manifest "$PROJECT_DIR/android/app/src/main/AndroidManifest.xml"',
    '--merged-debug-manifest "$DEBUG_MANIFEST"',
    '--merged-release-manifest "$RELEASE_MANIFEST"',
  ], 'Release manifest verifier');
  invariant(!source.includes('find "$MAINA_ANDROID_OUTPUT_ROOT"'), 'Release manifest verifier must not select retained outputs with find/head.');
}

export function runReleaseVerifierMutationCorpus(source) {
  validateReleaseVerifierSource(source);
  const cases = [];
  for (const [label, token] of [
    ['release task removed', ':app:processReleaseMainManifest'],
    ['debug regular-file guard removed', '[[ ! -f "$DEBUG_MANIFEST" || -L "$DEBUG_MANIFEST" ]]'],
    ['release regular-file guard removed', '[[ ! -f "$RELEASE_MANIFEST" || -L "$RELEASE_MANIFEST" ]]'],
    ['generated manifest validation removed', '--generated-manifest "$PROJECT_DIR/android/app/src/main/AndroidManifest.xml"'],
    ['debug merged validation removed', '--merged-debug-manifest "$DEBUG_MANIFEST"'],
    ['release merged validation removed', '--merged-release-manifest "$RELEASE_MANIFEST"'],
  ]) {
    expectReject(label, () => validateReleaseVerifierSource(source.replace(token, '# removed')));
    cases.push(label);
  }
  const releaseTask = ':app:processReleaseMainManifest';
  const releasePath = 'RELEASE_MANIFEST="$MAINA_ANDROID_OUTPUT_ROOT/_app/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml"';
  invariant(source.split(releaseTask).length === 2, 'Release verifier must contain exactly one release manifest task token.');
  invariant(source.split(releasePath).length === 2, 'Release verifier must contain exactly one release manifest path token.');
  const withoutReleaseTask = source.replace(releaseTask, '');
  const reordered = withoutReleaseTask.replace(
    releasePath,
    `${releasePath}\n${releaseTask}`,
  );
  invariant(reordered.split(releaseTask).length === 2, 'Reordered mutant must contain exactly one release manifest task token.');
  invariant(reordered.indexOf(releaseTask) > reordered.indexOf(releasePath), 'Reordered mutant must move the release manifest task after its output path.');
  expectReject('release task reordered', () => validateReleaseVerifierSource(reordered));
  cases.push('release task reordered');
  return cases;
}

async function readBoundManifest(file, label) {
  invariant(path.isAbsolute(file), `${label} path must be absolute.`);
  const stat = lstatSync(file);
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file.`);
  return AndroidConfig.Manifest.readAndroidManifestAsync(file);
}

function expectReject(label, operation) {
  let rejected = false;
  try {
    operation();
  } catch {
    rejected = true;
  }
  invariant(rejected, `Adversarial command-surface mutation was accepted: ${label}`);
}

export function runMutationCorpus(appConfig, moduleManifest, generatedManifest, triggerSource, recorderModuleSource, nativeSources, soakSource, bridgeSource) {
  const cases = [];
  const reject = (label, operation) => {
    expectReject(label, operation);
    cases.push(label);
  };

  for (const value of ['true', undefined]) {
    reject(`receiver exported ${String(value)}`, () => {
      const candidate = clone(moduleManifest);
      const attributes = candidate.manifest.application[0].receiver[0].$;
      if (value === undefined) delete attributes['android:exported'];
      else attributes['android:exported'] = value;
      validateModuleManifest(candidate);
    });
  }
  reject('receiver unknown attribute', () => {
    const candidate = clone(moduleManifest);
    candidate.manifest.application[0].receiver[0].$['android:permission'] = 'arbitrary';
    validateModuleManifest(candidate);
  });
  for (const mutation of ['missing', 'duplicate', 'extra']) {
    reject(`receiver action ${mutation}`, () => {
      const candidate = clone(moduleManifest);
      const actions = candidate.manifest.application[0].receiver[0]['intent-filter'][0].action;
      if (mutation === 'missing') actions.pop();
      if (mutation === 'duplicate') actions.push(clone(actions[0]));
      if (mutation === 'extra') actions.push({ $: { [ANDROID_NAME]: 'com.divay.maina.action.UNKNOWN' } });
      validateModuleManifest(candidate);
    });
  }
  reject('accessibility permission removed', () => {
    const candidate = clone(moduleManifest);
    delete candidate.manifest.application[0].service[2].$['android:permission'];
    validateModuleManifest(candidate);
  });
  for (const mutation of ['missing', 'duplicate', 'extra', 'shorthand']) {
    reject(`blocked permission ${mutation}`, () => {
      const candidate = clone(appConfig);
      if (mutation === 'missing') candidate.expo.android.blockedPermissions.pop();
      if (mutation === 'duplicate') candidate.expo.android.blockedPermissions.push(BLOCKED_PERMISSIONS[0]);
      if (mutation === 'extra') candidate.expo.android.blockedPermissions.push('android.permission.CAMERA');
      if (mutation === 'shorthand') candidate.expo.android.blockedPermissions[0] = 'READ_EXTERNAL_STORAGE';
      validateAppConfig(candidate);
    });
  }
  reject('blocked permission actively requested', () => {
    const candidate = clone(appConfig);
    candidate.expo.android.permissions.push('SYSTEM_ALERT_WINDOW');
    validateAppConfig(candidate);
  });
  for (const mutation of ['marker missing', 'marker active', 'marker extra attribute']) {
    reject(`generated permission ${mutation}`, () => {
      const candidate = clone(generatedManifest);
      const permissions = candidate.manifest['uses-permission'];
      const match = permissions.find((entry) => entry.$[ANDROID_NAME] === BLOCKED_PERMISSIONS[0]);
      if (mutation === 'marker missing') permissions.splice(permissions.indexOf(match), 1);
      if (mutation === 'marker active') delete match.$[TOOLS_NODE];
      if (mutation === 'marker extra attribute') match.$['android:maxSdkVersion'] = '32';
      validateGeneratedManifest(candidate);
    });
  }
  for (const tag of ['uses-permission-sdk-23', 'uses-permission-sdk-m']) {
    reject(`generated alternate permission ${tag}`, () => {
      const candidate = clone(generatedManifest);
      candidate.manifest[tag] = [{ $: { [ANDROID_NAME]: BLOCKED_PERMISSIONS[0] } }];
      validateGeneratedManifest(candidate);
    });
  }
  reject('module exported shadow command receiver', () => {
    const candidate = clone(moduleManifest);
    candidate.manifest.application[0].receiver.push({
      $: { [ANDROID_NAME]: 'com.divay.maina.recorder.ShadowCommandReceiver', 'android:enabled': 'true', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { [ANDROID_NAME]: COMMAND_ACTIONS[0] } }] }],
    });
    validateModuleManifest(candidate);
  });
  for (const mutation of ['permission removed', 'permission weakened', 'intent filter added']) {
    reject(`shell receiver ${mutation}`, () => {
      const candidate = clone(moduleManifest);
      const receiver = candidate.manifest.application[0].receiver.find((entry) => entry.$[ANDROID_NAME] === SHELL_RECEIVER);
      if (mutation === 'permission removed') delete receiver.$['android:permission'];
      if (mutation === 'permission weakened') receiver.$['android:permission'] = 'android.permission.INTERNET';
      if (mutation === 'intent filter added') receiver['intent-filter'] = [{ action: [{ $: { [ANDROID_NAME]: 'com.divay.maina.recorder.SHELL_COMMAND' } }] }];
      validateModuleManifest(candidate);
    });
  }
  reject('external source label', () => validateTriggerSource(triggerSource.replace('"internal-intent"', '"external-intent"')));
  const recorderModuleRelative = 'modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt';
  const mutateRecorder = (replace, replacement) => new Map(nativeSources).set(recorderModuleRelative, recorderModuleSource.replace(replace, replacement));
  reject('dynamic receiver exported', () => validateDynamicReceiverSources(mutateRecorder('ContextCompat.RECEIVER_NOT_EXPORTED', 'ContextCompat.RECEIVER_EXPORTED')));
  reject('dynamic receiver legacy overload', () => validateDynamicReceiverSources(mutateRecorder('ContextCompat.registerReceiver(', 'context.registerReceiver(')));
  reject('dynamic receiver missing flag', () => validateDynamicReceiverSources(mutateRecorder('ContextCompat.RECEIVER_NOT_EXPORTED,', '0,')));
  reject('dynamic receiver shadow registration', () => validateDynamicReceiverSources(new Map(nativeSources).set('modules/shadow/android/src/main/java/Shadow.kt', 'fun register(context: android.content.Context, receiver: android.content.BroadcastReceiver) { context.registerReceiver(receiver, android.content.IntentFilter("com.divay.maina.recorder.HARDWARE_TRIGGER")) }')));
  reject('dynamic receiver Java shadow registration', () => validateDynamicReceiverSources(new Map(nativeSources).set('modules/shadow/android/src/main/java/Shadow.java', 'void register(Context context, BroadcastReceiver receiver) { context.registerReceiver(receiver, new IntentFilter("com.divay.maina.recorder.HARDWARE_TRIGGER")); }')));
  reject('soak public broadcast restored', () => validateOperationalScripts(soakSource.replace('"$ADB" shell am broadcast', '"$ADB" shell am broadcast -a com.divay.maina.action.STOP #'), bridgeSource));
  reject('soak duplicate stop restored', () => validateOperationalScripts(soakSource.replace('snapshot "stopping"', 'snapshot "stopping"\n    send_stop'), bridgeSource));
  reject('bridge global media dispatch restored', () => validateOperationalScripts(soakSource, `${bridgeSource}\ncmd media_session dispatch play-pause`));
  reject('bridge arming guard removed', () => validateOperationalScripts(soakSource, bridgeSource.replace("grep -q 'MainaRecordingService'", 'grep -q other-service')));
  reject('bridge state acknowledgment removed', () => validateOperationalScripts(soakSource, bridgeSource.replace('wait_for_state_ack "$before" "$command"', 'false')));
  return cases;
}

export function runMergedMutationCorpus(mergedManifest, variant) {
  validateMergedManifest(mergedManifest, variant);
  const cases = [];
  const reject = (label, operation) => {
    expectReject(label, operation);
    cases.push(label);
  };
  reject('merged forbidden permission', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest['uses-permission'].push({ $: { [ANDROID_NAME]: BLOCKED_PERMISSIONS[0] } });
    validateMergedManifest(candidate, variant);
  });
  reject('merged alternate permission element', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest['uses-permission-sdk-23'] = [candidate.manifest['uses-permission'].pop()];
    validateMergedManifest(candidate, variant);
  });
  reject('merged legacy alternate permission element', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest['uses-permission-sdk-m'] = [candidate.manifest['uses-permission'].pop()];
    validateMergedManifest(candidate, variant);
  });
  reject('merged unknown permission', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest['uses-permission'].push({ $: { [ANDROID_NAME]: 'android.permission.CAMERA' } });
    validateMergedManifest(candidate, variant);
  });
  reject('merged permission attribute', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest['uses-permission'][0].$['android:maxSdkVersion'] = '32';
    validateMergedManifest(candidate, variant);
  });
  for (const mutation of ['exported', 'missing', 'duplicate', 'action removed', 'action added']) {
    reject(`merged receiver ${mutation}`, () => {
      const candidate = clone(mergedManifest);
      const receivers = candidate.manifest.application[0].receiver;
      const receiver = receivers.find((entry) => entry.$[ANDROID_NAME] === COMMAND_RECEIVER);
      if (mutation === 'exported') receiver.$['android:exported'] = 'true';
      if (mutation === 'missing') receivers.splice(receivers.indexOf(receiver), 1);
      if (mutation === 'duplicate') receivers.push(clone(receiver));
      if (mutation === 'action removed') receiver['intent-filter'][0].action.pop();
      if (mutation === 'action added') receiver['intent-filter'][0].action.push({ $: { [ANDROID_NAME]: 'com.divay.maina.action.UNKNOWN' } });
      validateMergedManifest(candidate, variant);
    });
  }
  reject('merged exported shadow command receiver', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest.application[0].receiver.push({
      $: { [ANDROID_NAME]: 'com.divay.maina.recorder.ShadowCommandReceiver', 'android:enabled': 'true', 'android:exported': 'true' },
      'intent-filter': [{ action: [{ $: { [ANDROID_NAME]: COMMAND_ACTIONS[0] } }] }],
    });
    validateMergedManifest(candidate, variant);
  });
  reject('merged shell receiver permission removed', () => {
    const candidate = clone(mergedManifest);
    const receiver = candidate.manifest.application[0].receiver.find((entry) => entry.$[ANDROID_NAME] === SHELL_RECEIVER);
    delete receiver.$['android:permission'];
    validateMergedManifest(candidate, variant);
  });
  for (const mutation of ['permission removed', 'permission weakened', 'process changed', 'action changed', 'metadata changed']) {
    reject(`merged accessibility ${mutation}`, () => {
      const candidate = clone(mergedManifest);
      const service = candidate.manifest.application[0].service.find((entry) => entry.$[ANDROID_NAME] === ACCESSIBILITY_SERVICE);
      if (mutation === 'permission removed') delete service.$['android:permission'];
      if (mutation === 'permission weakened') service.$['android:permission'] = 'android.permission.INTERNET';
      if (mutation === 'process changed') service.$['android:process'] = ':other';
      if (mutation === 'action changed') service['intent-filter'][0].action[0].$[ANDROID_NAME] = 'android.intent.action.VIEW';
      if (mutation === 'metadata changed') service['meta-data'][0].$['android:resource'] = '@xml/other';
      validateMergedManifest(candidate, variant);
    });
  }
  reject('merged dynamic permission missing', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest.permission = [];
    validateMergedManifest(candidate, variant);
  });
  reject('merged dynamic permission weakened', () => {
    const candidate = clone(mergedManifest);
    candidate.manifest.permission[0].$['android:protectionLevel'] = 'normal';
    validateMergedManifest(candidate, variant);
  });
  return cases;
}

async function main() {
  const appConfig = JSON.parse(readFileSync(path.join(project, 'app.json'), 'utf8'));
  const modulePath = path.join(project, 'modules', 'maina-recorder', 'android', 'src', 'main', 'AndroidManifest.xml');
  const triggerPath = path.join(project, 'modules', 'maina-recorder', 'android', 'src', 'main', 'java', 'com', 'divay', 'maina', 'recorder', 'MainaHardwareTrigger.kt');
  const recorderModulePath = path.join(project, 'modules', 'maina-recorder', 'android', 'src', 'main', 'java', 'com', 'divay', 'maina', 'recorder', 'MainaRecorderModule.kt');
  const moduleManifest = await readBoundManifest(modulePath, 'module manifest');
  const triggerSource = readFileSync(triggerPath, 'utf8');
  const recorderModuleSource = readFileSync(recorderModulePath, 'utf8');
  const nativeSources = readNativeReceiverSources();
  const hostileFixtureSource = readFileSync(path.join(project, HOSTILE_FIXTURE_SOURCE), 'utf8');
  const emulatorVerifierSource = readFileSync(path.join(project, EMULATOR_VERIFIER_SOURCE), 'utf8');
  const soakSource = readFileSync(path.join(project, 'scripts', 'android-soak-monitor.sh'), 'utf8');
  const bridgeSource = readFileSync(path.join(project, 'scripts', 'maina-button-bridge.sh'), 'utf8');
  const releaseVerifierSource = readFileSync(path.join(project, 'scripts', 'verify-release.sh'), 'utf8');
  const generatedFixture = syntheticGeneratedManifest();
  validateAppConfig(appConfig);
  validateModuleManifest(moduleManifest);
  validateGeneratedManifest(generatedFixture);
  validateTriggerSource(triggerSource);
  validateDynamicReceiverSources(nativeSources);
  validateHostileFixtureSource(hostileFixtureSource);
  validateEmulatorVerifierSource(emulatorVerifierSource);
  validateOperationalScripts(soakSource, bridgeSource);
  validateReleaseVerifierSource(releaseVerifierSource);
  const cases = runMutationCorpus(appConfig, moduleManifest, generatedFixture, triggerSource, recorderModuleSource, nativeSources, soakSource, bridgeSource);
  const debugMergedCases = runMergedMutationCorpus(syntheticMergedManifest(moduleManifest, 'debug'), 'debug');
  const releaseMergedCases = runMergedMutationCorpus(syntheticMergedManifest(moduleManifest, 'release'), 'release');
  const releaseVerifierCases = runReleaseVerifierMutationCorpus(releaseVerifierSource);
  const hostileFixtureCases = runHostileFixtureMutationCorpus(hostileFixtureSource);
  const emulatorVerifierCases = runEmulatorVerifierMutationCorpus(emulatorVerifierSource);

  const supplied = new Map();
  const args = process.argv.slice(2);
  invariant(args.length % 2 === 0, 'Command-line manifest options require path values.');
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const file = args[index + 1];
    invariant(
      option === '--generated-manifest' || option === '--merged-debug-manifest' || option === '--merged-release-manifest',
      `Unknown command-line option: ${option}`,
    );
    invariant(!supplied.has(option), `Duplicate command-line option: ${option}`);
    supplied.set(option, file);
  }
  if (supplied.has('--generated-manifest')) {
    validateGeneratedManifest(await readBoundManifest(supplied.get('--generated-manifest'), 'generated manifest'));
  }
  if (supplied.has('--merged-debug-manifest')) {
    validateMergedManifest(await readBoundManifest(supplied.get('--merged-debug-manifest'), 'debug merged manifest'), 'debug');
  }
  if (supplied.has('--merged-release-manifest')) {
    validateMergedManifest(await readBoundManifest(supplied.get('--merged-release-manifest'), 'release merged manifest'), 'release');
  }
  console.log(
    `Android command surface verified; ${cases.length + debugMergedCases.length + releaseMergedCases.length + releaseVerifierCases.length + hostileFixtureCases.length + emulatorVerifierCases.length} adversarial mutations rejected.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
