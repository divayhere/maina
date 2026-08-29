import assert from 'node:assert/strict';
import { validateAndroidUpdate } from './lib/renewal-core.mjs';

const valid = {
  serial: 'pixel', expectedSerial: 'pixel', connection: 'usb',
  packageName: 'com.divay.maina', expectedPackageName: 'com.divay.maina',
  installedSigner: 'abc', candidateSigner: 'abc',
};
assert.equal(validateAndroidUpdate(valid), true);
assert.throws(() => validateAndroidUpdate({ ...valid, candidateSigner: 'different' }), /certificate/);
assert.throws(() => validateAndroidUpdate({ ...valid, connection: 'wireless' }), /USB/);
console.log('Android renewal safety policy verified.');
