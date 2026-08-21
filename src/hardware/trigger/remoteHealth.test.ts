import { describe, expect, it } from 'vitest';

import type { RemoteControlStatus } from '../../../modules/maina-recorder/src';
import { describeRemoteHealth, formatRemoteLastPress } from './remoteHealth';

const baseRemote: RemoteControlStatus = {
  armed: true,
  captureState: 'idle',
  accessibilityEnabled: true,
  accessibilityConnected: true,
  accessibilityLastLifecycle: 'connected',
  accessibilityLastLifecycleAt: 1_000,
  accessibilityLastLifecycleBootCount: 7,
  accessibilityCurrentBootCount: 7,
  accessibilityLastLifecyclePackageUpdatedAt: 10,
  accessibilityCurrentPackageUpdatedAt: 10,
  notificationsEnabled: true,
  inputDevices: ['AB Shutter (#11)'],
  lastCommand: 'toggle',
  lastCommandId: 'abc',
  lastSource: 'accessibility-hid',
  lastDeviceName: 'AB Shutter',
  lastKeyCode: 24,
  lastCommandAt: 0,
  lastAckAction: 'start-recorder',
  lastAckAccepted: true,
  lastAckAt: 0,
  trustedRemoteName: 'AB Shutter',
};

describe('describeRemoteHealth', () => {
  it('flags missing accessibility permission', () => {
    const health = describeRemoteHealth({ ...baseRemote, accessibilityEnabled: false, accessibilityConnected: false });
    expect(health.statusLabel).toBe('Permission needed');
    expect(health.ctaAction).toBe('accessibility');
  });

  it('flags reconnecting listener separately from missing permission', () => {
    const health = describeRemoteHealth({
      ...baseRemote,
      accessibilityConnected: false,
      accessibilityLastLifecycle: 'destroyed',
      accessibilityLastLifecycleAt: 5_000,
    });
    expect(health.statusLabel).toBe('Reconnecting');
    expect(health.detail).toContain('destroyed');
  });

  it('treats a live remote as ready', () => {
    const health = describeRemoteHealth({ ...baseRemote, lastCommandAt: 60_000 }, 61_000);
    expect(health.statusLabel).toBe('Ready');
    expect(health.detail).toContain('just now');
  });

  it('shows unarmed state before anything else', () => {
    const health = describeRemoteHealth({ ...baseRemote, armed: false, accessibilityEnabled: false, accessibilityConnected: false });
    expect(health.statusLabel).toBe('Not armed');
  });
});

describe('formatRemoteLastPress', () => {
  it('uses a friendly empty state', () => {
    expect(formatRemoteLastPress({ ...baseRemote, lastCommandAt: 0 })).toBe('No press received yet');
  });
});
