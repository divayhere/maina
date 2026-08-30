export function validateAndroidUpdate(input) {
  if (input.serial !== input.expectedSerial) throw new Error('Android serial mismatch.');
  if (input.connection !== 'wifi-adb') throw new Error('Android target is not the pinned Wi-Fi ADB endpoint.');
  if (!input.hardwareSerial || input.hardwareSerial !== input.expectedHardwareSerial) {
    throw new Error('Android hardware serial mismatch.');
  }
  if (input.packageName !== input.expectedPackageName) throw new Error('Android package mismatch.');
  if (!input.installedSigner || input.installedSigner !== input.candidateSigner) {
    throw new Error('Android signing certificate mismatch.');
  }
  return true;
}
