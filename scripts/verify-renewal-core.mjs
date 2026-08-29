import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  findInstalledIosApp,
  findQualifiedIosDevice,
  validateAndroidUpdate,
  validateCandidateIdentity,
  validateDataSnapshot,
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

assert.equal(validateAndroidUpdate({
  serial: 'pixel', expectedSerial: 'pixel', connection: 'usb',
  packageName: 'com.divay.maina', expectedPackageName: 'com.divay.maina',
  installedSigner: 'abc', candidateSigner: 'abc',
}), true);
assert.throws(() => validateAndroidUpdate({
  serial: 'pixel', expectedSerial: 'pixel', connection: 'usb',
  packageName: 'com.divay.maina', expectedPackageName: 'com.divay.maina',
  installedSigner: 'abc', candidateSigner: 'different',
}), /certificate/);

const iosRenewalScript = readFileSync(new URL('./renew-ios-personal.sh', import.meta.url), 'utf8');
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

console.log('Renewal safety policy verified.');
