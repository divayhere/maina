import assert from 'node:assert/strict';
import { validateAndroidUpdate } from './lib/renewal-core.mjs';

const valid = {
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
assert.equal(validateAndroidUpdate(valid), true);
assert.throws(() => validateAndroidUpdate({ ...valid, candidateSigner: 'different' }), /certificate/);
for (const connection of ['wireless', 'usb', 'emulator']) {
  assert.throws(() => validateAndroidUpdate({ ...valid, connection }), /Wi-Fi ADB transport/);
}
assert.throws(() => validateAndroidUpdate({
  ...valid,
  serial: 'emulator-5554',
  expectedSerial: 'emulator-5554',
}), /pinned Wi-Fi ADB endpoint/);
assert.throws(() => validateAndroidUpdate({ ...valid, serial: 'another._adb-tls-connect._tcp' }), /endpoint mismatch/);
assert.throws(() => validateAndroidUpdate({ ...valid, hardwareSerial: 'WRONG' }), /hardware serial/);
assert.throws(() => validateAndroidUpdate({ ...valid, model: 'Pixel 8' }), /model/);
assert.throws(() => validateAndroidUpdate({ ...valid, installedPackageName: 'other.package' }), /package/);
assert.throws(() => validateAndroidUpdate({ ...valid, candidatePackageName: 'other.package' }), /package/);
assert.throws(() => validateAndroidUpdate({ ...valid, installedSigner: '' }), /certificate/);
console.log('Android renewal safety policy verified.');
