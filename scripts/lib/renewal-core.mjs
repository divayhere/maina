export function validateAndroidUpdate(input) {
  if (input.connection !== 'wifi-adb') {
    throw new Error('Android target is not the approved Wi-Fi ADB transport.');
  }
  if (!input.serial || input.serial !== input.expectedSerial) {
    throw new Error('Android Wi-Fi ADB endpoint mismatch.');
  }
  if (!input.serial.endsWith('._adb-tls-connect._tcp') || input.serial.startsWith('emulator-')) {
    throw new Error('Android target is not a pinned Wi-Fi ADB endpoint.');
  }
  if (!input.hardwareSerial || input.hardwareSerial !== input.expectedHardwareSerial) {
    throw new Error('Android hardware serial mismatch.');
  }
  if (!input.model || input.model !== input.expectedModel) {
    throw new Error('Android model mismatch.');
  }
  if (
    !input.installedPackageName
    || input.installedPackageName !== input.expectedPackageName
    || input.candidatePackageName !== input.expectedPackageName
  ) {
    throw new Error('Android package mismatch.');
  }
  if (!input.installedSigner || input.installedSigner !== input.candidateSigner) {
    throw new Error('Android signing certificate mismatch.');
  }
  return true;
}
