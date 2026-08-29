export function validateAndroidUpdate(input) {
  if (input.serial !== input.expectedSerial) throw new Error('Android serial mismatch.');
  if (input.connection !== 'usb') throw new Error('Android target is not USB-connected.');
  if (input.packageName !== input.expectedPackageName) throw new Error('Android package mismatch.');
  if (!input.installedSigner || input.installedSigner !== input.candidateSigner) {
    throw new Error('Android signing certificate mismatch.');
  }
  return true;
}
