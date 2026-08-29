export function findQualifiedIosDevice(payload, expected) {
  const devices = payload?.result?.devices ?? [];
  const device = devices.find((item) => item.identifier === expected.deviceId);
  if (!device) throw new Error(`Qualified iOS device is missing: ${expected.deviceId}`);
  if (device.hardwareProperties?.udid !== expected.udid) throw new Error('iOS UDID mismatch.');
  if (device.hardwareProperties?.marketingName !== expected.marketingName) throw new Error('iOS model mismatch.');
  if (device.hardwareProperties?.reality !== 'physical') throw new Error('iOS target is not physical.');
  if (device.connectionProperties?.transportType !== 'wired') throw new Error('iOS target is not connected by USB.');
  if (device.connectionProperties?.tunnelState !== 'connected') throw new Error('iOS device tunnel is not connected.');
  if (device.connectionProperties?.pairingState !== 'paired') throw new Error('iOS device is not paired.');
  if (device.deviceProperties?.developerModeStatus !== 'enabled') throw new Error('iOS Developer Mode is disabled.');
  return device;
}

export function findInstalledIosApp(payload, bundleId) {
  const apps = payload?.result?.apps ?? [];
  const app = apps.find((item) => item.bundleIdentifier === bundleId);
  if (!app) throw new Error(`Installed iOS app is missing: ${bundleId}`);
  if (app.bundleIdentifier !== bundleId) throw new Error('Installed iOS bundle mismatch.');
  return {
    bundleId: app.bundleIdentifier,
    version: String(app.version ?? ''),
    build: String(app.bundleVersion ?? ''),
  };
}

export function validateDataSnapshot(before, after) {
  const nonDecreasing = ['meetings', 'transcriptBlocks', 'todos', 'pipelineStages'];
  for (const key of nonDecreasing) {
    if ((after[key] ?? 0) < (before[key] ?? 0)) {
      throw new Error(`Post-install ${key} count decreased (${before[key]} -> ${after[key]}).`);
    }
  }
  if (before.hasDurableLog && !after.hasDurableLog) throw new Error('Durable app log disappeared.');
  if (before.hasQwenModel && !after.hasQwenModel) throw new Error('Qwen model disappeared.');
  return true;
}

export function validateCandidateIdentity(candidate, expected) {
  if (candidate.bundleId !== expected.bundleId) throw new Error('Candidate bundle ID mismatch.');
  if (candidate.teamId !== expected.teamId) throw new Error('Candidate Team ID mismatch.');
  if (candidate.applicationIdentifier !== `${expected.teamId}.${expected.bundleId}`) {
    throw new Error('Candidate application identifier mismatch.');
  }
  if (!candidate.keychainGroups.includes(`${expected.teamId}.${expected.bundleId}`)) {
    throw new Error('Candidate Keychain access group mismatch.');
  }
  if (!(candidate.profileExpiresAt instanceof Date) || Number.isNaN(candidate.profileExpiresAt.valueOf())) {
    throw new Error('Candidate provisioning expiry is invalid.');
  }
  if (candidate.profileExpiresAt.valueOf() <= expected.minimumExpiryMs) {
    throw new Error('Candidate provisioning profile expires too soon.');
  }
  return true;
}

export function validateAndroidUpdate(input) {
  if (input.serial !== input.expectedSerial) throw new Error('Android serial mismatch.');
  if (input.connection !== 'usb') throw new Error('Android target is not USB-connected.');
  if (input.packageName !== input.expectedPackageName) throw new Error('Android package mismatch.');
  if (!input.installedSigner || input.installedSigner !== input.candidateSigner) {
    throw new Error('Android signing certificate mismatch.');
  }
  return true;
}
