import { describe, expect, it } from 'vitest';

import { resolveRemoteAction } from './remoteControl';

describe('remote control state machine', () => {
  it('uses one button for start, pause, and resume', () => {
    expect(resolveRemoteAction('idle', 'toggle')).toBe('start');
    expect(resolveRemoteAction('recording', 'toggle')).toBe('pause');
    expect(resolveRemoteAction('paused', 'toggle')).toBe('resume');
  });

  it('stops only an active meeting', () => {
    expect(resolveRemoteAction('recording', 'stop')).toBe('stop');
    expect(resolveRemoteAction('paused', 'stop')).toBe('stop');
    expect(resolveRemoteAction('idle', 'stop')).toBe('ignore');
  });

  it('ignores commands while finalizing', () => {
    for (const command of ['start', 'toggle', 'pause', 'resume', 'stop'] as const) {
      expect(resolveRemoteAction('finalizing', command)).toBe('ignore');
    }
  });

  it('does not reinterpret explicit commands in an unsafe state', () => {
    expect(resolveRemoteAction('idle', 'pause')).toBe('ignore');
    expect(resolveRemoteAction('recording', 'resume')).toBe('ignore');
    expect(resolveRemoteAction('recording', 'start')).toBe('ignore');
  });
});
