import assert from 'node:assert/strict';
import { validateAndroidUpdate } from './lib/renewal-core.mjs';

const valid = {
  serial: 'pixel-wifi', expectedSerial: 'pixel-wifi', connection: 'wifi-adb',
  hardwareSerial: 'pixel-hardware', expectedHardwareSerial: 'pixel-hardware',
  packageName: 'com.divay.maina', expectedPackageName: 'com.divay.maina',
  installedSigner: 'abc', candidateSigner: 'abc',
};
assert.equal(validateAndroidUpdate(valid), true);
assert.throws(() => validateAndroidUpdate({ ...valid, candidateSigner: 'different' }), /certificate/);
assert.throws(() => validateAndroidUpdate({ ...valid, connection: 'usb' }), /Wi-Fi/);
assert.throws(() => validateAndroidUpdate({ ...valid, hardwareSerial: 'another-phone' }), /hardware serial/);
console.log('Android renewal safety policy verified.');
