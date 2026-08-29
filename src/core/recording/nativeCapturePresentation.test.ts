import { describe, expect, it } from 'vitest';

import { nativeCapturePresentation } from './nativeCapturePresentation';

describe('native capture presentation', () => {
  it('restores recording controls after native interruption recovery', () => {
    expect(nativeCapturePresentation('recording')).toBe('recording');
  });

  it('keeps transitional and paused capture visibly paused', () => {
    expect(nativeCapturePresentation('pausing')).toBe('paused');
    expect(nativeCapturePresentation('paused')).toBe('paused');
    expect(nativeCapturePresentation('resuming')).toBe('paused');
  });

  it('does not invent a recording state for terminal native states', () => {
    expect(nativeCapturePresentation('idle')).toBe('unchanged');
    expect(nativeCapturePresentation('finalizing')).toBe('unchanged');
    expect(nativeCapturePresentation('error')).toBe('unchanged');
    expect(nativeCapturePresentation(null)).toBe('unchanged');
  });
});
