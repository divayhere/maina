import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  findInstalledIosApp,
  findQualifiedIosDevice,
  validateAndroidUpdate,
  validateCandidateIdentity,
  validateDataSnapshot,
  validateInstalledAndroidArtifact,
  validateInstalledIosArtifact,
} from './lib/renewal-core.mjs';

const expectedDevice = { deviceId: 'device', udid: 'udid', marketingName: 'iPhone 15' };
const devicePayload = { result: { devices: [{
  identifier: 'device',
  hardwareProperties: { udid: 'udid', marketingName: 'iPhone 15', reality: 'physical' },
  connectionProperties: { transportType: 'wired', tunnelState: 'connected', pairingState: 'paired' },
  deviceProperties: { developerModeStatus: 'enabled' },
}] } };
assert.equal(findQualifiedIosDevice(devicePayload, expectedDevice).identifier, 'device');
assert.throws(
  () => findQualifiedIosDevice({ result: { devices: [{
    ...devicePayload.result.devices[0],
    connectionProperties: { ...devicePayload.result.devices[0].connectionProperties, transportType: 'wireless' },
  }] } }, expectedDevice),
  /USB/,
);

const app = findInstalledIosApp({ result: { apps: [{
  bundleIdentifier: 'com.divay.maina.staging', version: '0.10.28', bundleVersion: 11,
}] } }, 'com.divay.maina.staging');
assert.deepEqual(app, { bundleId: 'com.divay.maina.staging', version: '0.10.28', build: '11' });
const approvedIos = { bundleId: 'com.divay.maina.staging', version: '0.10.48', build: '30' };
assert.equal(validateInstalledIosArtifact(approvedIos, approvedIos), true);
assert.throws(
  () => validateInstalledIosArtifact({ ...approvedIos, bundleId: 'com.divay.maina.other' }, approvedIos),
  /bundle does not match/,
);
assert.throws(
  () => validateInstalledIosArtifact({ ...approvedIos, version: '0.10.41' }, approvedIos),
  /version does not match/,
);
assert.throws(
  () => validateInstalledIosArtifact({ ...approvedIos, build: '23' }, approvedIos),
  /build does not match/,
);

assert.equal(validateDataSnapshot(
  { meetings: 2, transcriptBlocks: 10, todos: 1, pipelineStages: 4, hasDurableLog: true, hasQwenModel: true },
  { meetings: 2, transcriptBlocks: 10, todos: 1, pipelineStages: 4, hasDurableLog: true, hasQwenModel: true },
), true);
assert.throws(
  () => validateDataSnapshot(
    { meetings: 2, transcriptBlocks: 10 },
    { meetings: 1, transcriptBlocks: 10 },
  ),
  /decreased/,
);

assert.equal(validateCandidateIdentity({
  bundleId: 'com.divay.maina.staging',
  teamId: 'TEAM',
  applicationIdentifier: 'TEAM.com.divay.maina.staging',
  keychainGroups: ['TEAM.com.divay.maina.staging'],
  profileExpiresAt: new Date(Date.now() + 7 * 86_400_000),
}, {
  bundleId: 'com.divay.maina.staging', teamId: 'TEAM', minimumExpiryMs: Date.now() + 2 * 86_400_000,
}), true);
assert.equal(validateCandidateIdentity({
  bundleId: 'com.divay.maina.staging',
  teamId: 'TEAM',
  applicationIdentifier: 'TEAM.com.divay.maina.staging',
  keychainGroups: [],
  profileExpiresAt: new Date(Date.now() + 7 * 86_400_000),
}, {
  bundleId: 'com.divay.maina.staging', teamId: 'TEAM', minimumExpiryMs: Date.now() + 2 * 86_400_000,
}), true);
assert.throws(() => validateCandidateIdentity({
  bundleId: 'com.divay.maina.staging',
  teamId: 'TEAM',
  applicationIdentifier: 'TEAM.com.divay.maina.staging',
  keychainGroups: ['OTHER.another.app'],
  profileExpiresAt: new Date(Date.now() + 7 * 86_400_000),
}, {
  bundleId: 'com.divay.maina.staging', teamId: 'TEAM', minimumExpiryMs: Date.now() + 2 * 86_400_000,
}), /Keychain/);

const validAndroid = {
  serial: 'adb-47011FDAP000VE-test._adb-tls-connect._tcp',
  expectedSerial: 'adb-47011FDAP000VE-test._adb-tls-connect._tcp',
  connection: 'wifi-adb',
  hardwareSerial: '47011FDAP000VE', expectedHardwareSerial: '47011FDAP000VE',
  model: 'Pixel 9 Pro', expectedModel: 'Pixel 9 Pro',
  installedPackageName: 'com.divay.maina',
  candidatePackageName: 'com.divay.maina',
  expectedPackageName: 'com.divay.maina',
  installedSigner: 'abc', candidateSigner: 'abc',
};
assert.equal(validateAndroidUpdate(validAndroid), true);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, candidateSigner: 'different' }), /certificate/);
for (const connection of ['wireless', 'usb', 'emulator']) {
  assert.throws(() => validateAndroidUpdate({ ...validAndroid, connection }), /Wi-Fi ADB transport/);
}
assert.throws(() => validateAndroidUpdate({
  ...validAndroid,
  serial: 'emulator-5554',
  expectedSerial: 'emulator-5554',
}), /pinned Wi-Fi ADB endpoint/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, serial: 'another._adb-tls-connect._tcp' }), /endpoint mismatch/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, hardwareSerial: 'WRONG' }), /hardware serial/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, model: 'Pixel 8' }), /model/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, installedPackageName: 'other.package' }), /package/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, candidatePackageName: 'other.package' }), /package/);
assert.throws(() => validateAndroidUpdate({ ...validAndroid, installedSigner: '' }), /certificate/);

const installedAndroid = {
  candidateSha256: 'hash', installedSha256: 'hash',
  candidateSigner: 'signer', installedSigner: 'signer',
  candidateVersionCode: '70', installedVersionCode: '70',
  candidateVersionName: '0.10.48', installedVersionName: '0.10.48',
};
assert.equal(validateInstalledAndroidArtifact(installedAndroid), true);
assert.throws(() => validateInstalledAndroidArtifact({ ...installedAndroid, installedSha256: 'different' }), /hash/);
assert.throws(() => validateInstalledAndroidArtifact({ ...installedAndroid, installedSigner: 'different' }), /certificate/);
assert.throws(() => validateInstalledAndroidArtifact({ ...installedAndroid, installedVersionCode: '67' }), /version code/);
assert.throws(() => validateInstalledAndroidArtifact({ ...installedAndroid, installedVersionName: '0.10.41' }), /version name/);

const iosRenewalScript = readFileSync(new URL('./renew-ios-personal.sh', import.meta.url), 'utf8');
const iosInstaller = readFileSync(new URL('./install-ios-preserving-data.sh', import.meta.url), 'utf8');
const combinedIosBuilder = readFileSync(new URL('./build-install-ios-staging.sh', import.meta.url), 'utf8');
const backupInspector = readFileSync(new URL('./inspect-mobile-backup.mjs', import.meta.url), 'utf8');
assert.match(
  iosRenewalScript,
  /device info processes --device "\$DEVICE_ID" --timeout 15 --quiet/,
  'Renewal must acquire a fresh CoreDevice tunnel immediately before device validation.',
);
assert.match(
  iosRenewalScript,
  /plutil', \['-extract', 'ExpirationDate', 'raw', profile\]/,
  'Provisioning expiry must use locale-independent ISO-8601 output.',
);
assert.doesNotMatch(
  iosRenewalScript,
  /--source\s+\.\s+--destination/,
  'CoreDevice rejects app-container source "."; use the accepted root path "/".',
);
assert.match(iosRenewalScript, /--source \/ --destination "\$RUN_ROOT\/preflight\/container"/);
assert.match(iosRenewalScript, /--source \/ --destination "\$RUN_ROOT\/postflight-container"/);
assert.match(iosRenewalScript, /if \(snapshot\.activeRecordings > 0\)/);
assert.doesNotMatch(
  iosRenewalScript,
  /snapshot\.activeStages > 0\) \{\s*throw new Error/,
  'Durable ASR/summary work must not block a certificate-only in-place update.',
);
assert.match(backupInspector, /status = 'recording'/);
assert.match(backupInspector, /recoverableProcessingMeetings/);
assert.match(combinedIosBuilder, /Refusing combined candidate build\/install/);
assert.match(iosRenewalScript, /Refusing build-and-install renewal for the active candidate/);
assert.match(iosInstaller, /release-provenance-cli\.mjs authorize ios/);
assert.match(iosInstaller, /release-provenance-cli\.mjs replay-config/);
assert.match(iosInstaller, /BUNDLE_ID" == "\$EXPECTED_BUNDLE_ID/);
assert.ok(
  iosInstaller.indexOf('release-provenance-cli.mjs authorize ios') < iosInstaller.indexOf('xcrun devicectl'),
  'Dual-platform provenance authorization must run before any iOS device access.',
);
assert.equal((iosInstaller.match(/device install app/g) ?? []).length, 1, 'iOS installer must have one install call.');
const installIndex = iosInstaller.indexOf('device install app');
const postInstallQueryIndex = iosInstaller.indexOf('apps-after.json');
const identityReconcileIndex = iosInstaller.indexOf('validateInstalledIosArtifact(installed');
const unlockIndex = iosInstaller.indexOf('terminal_reconciled=1');
assert.ok(installIndex < postInstallQueryIndex, 'Installed iOS identity must be queried after the single install.');
assert.ok(postInstallQueryIndex < identityReconcileIndex, 'Fresh installed identity must be validated.');
assert.ok(identityReconcileIndex < unlockIndex, 'Installed identity must reconcile before the retained lock is cleared.');
for (const forbidden of ['uninstall', 'erase', 'simctl', 'rm -rf']) {
  assert.doesNotMatch(iosInstaller, new RegExp(forbidden), `iOS installer contains forbidden ${forbidden}.`);
}

console.log('Renewal safety policy verified.');
