import type { RemoteControlStatus } from '../../../modules/maina-recorder/src';

export interface RemoteHealth {
  tone: 'ready' | 'warn';
  title: string;
  detail: string;
  ctaLabel: string | null;
  ctaAction: 'accessibility' | 'none';
  statusLabel: string;
}

export function describeRemoteHealth(
  remote: RemoteControlStatus | null,
  now = Date.now(),
): RemoteHealth {
  if (!remote) {
    return {
      tone: 'warn',
      title: 'Checking clicker status',
      detail: 'Maina is reading the remote-control state from Android.',
      ctaLabel: null,
      ctaAction: 'none',
      statusLabel: 'Checking…',
    };
  }

  if (!remote.armed) {
    return {
      tone: 'warn',
      title: 'Open Maina once before using the clicker',
      detail: 'Android needs Maina armed in the foreground once after a force-stop or reboot.',
      ctaLabel: null,
      ctaAction: 'none',
      statusLabel: 'Not armed',
    };
  }

  if (!remote.accessibilityEnabled) {
    return {
      tone: 'warn',
      title: 'Enable locked-screen clicker control',
      detail: 'Your shutter clicker can still change volume until Accessibility permission is turned on for Maina.',
      ctaLabel: 'Enable clicker control',
      ctaAction: 'accessibility',
      statusLabel: 'Permission needed',
    };
  }

  if (!remote.accessibilityConnected) {
    const lifecycle = formatLifecycle(remote);
    return {
      tone: 'warn',
      title: 'Android has not reconnected the clicker listener yet',
      detail: lifecycle
        ? `Permission is on, but the listener is not live right now (${lifecycle}). Open the accessibility page once and verify a press.`
        : 'Permission is on, but the listener is not live right now. Open the accessibility page once and verify a press.',
      ctaLabel: 'Reconnect clicker',
      ctaAction: 'accessibility',
      statusLabel: 'Reconnecting',
    };
  }

  const minutesSincePress = remote.lastCommandAt > 0 ? Math.floor((now - remote.lastCommandAt) / 60_000) : null;
  return {
    tone: 'ready',
    title: 'Clicker is ready',
    detail: minutesSincePress !== null && minutesSincePress < 15
      ? `Last press received ${minutesSincePress <= 0 ? 'just now' : `${minutesSincePress} min ago`}.`
      : 'Locked-screen clicker control is armed and ready for the next meeting.',
    ctaLabel: null,
    ctaAction: 'none',
    statusLabel: 'Ready',
  };
}

export function formatRemoteLastPress(remote: RemoteControlStatus | null): string {
  if (!remote || remote.lastCommandAt <= 0) return 'No press received yet';
  return `${remote.lastCommand} · ${new Date(remote.lastCommandAt).toLocaleTimeString()}`;
}

function formatLifecycle(remote: RemoteControlStatus): string | null {
  if (!remote.accessibilityLastLifecycle || remote.accessibilityLastLifecycle === 'never') return null;
  return `${remote.accessibilityLastLifecycle} · ${new Date(remote.accessibilityLastLifecycleAt).toLocaleTimeString()}`;
}
