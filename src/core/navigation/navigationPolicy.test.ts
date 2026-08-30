import { describe, expect, it, vi } from 'vitest';

import { backOrHome, openNewlySavedMeetingRoute } from './navigationPolicy';

describe('Maina navigation policy', () => {
  it('resets a global recording to Home before pushing the saved meeting', () => {
    const events: string[] = [];
    openNewlySavedMeetingRoute({
      dismissTo: (href) => events.push(`dismiss:${href}`),
      push: (href) => events.push(`push:${href}`),
    }, 'meeting-b', (work) => work());
    expect(events).toEqual(['dismiss:/', 'push:/meeting/meeting-b']);
  });

  it('uses native history when available and Home for an orphan/deep link', () => {
    const back = vi.fn();
    const home = vi.fn();
    backOrHome({ canGoBack: true, back, home });
    expect(back).toHaveBeenCalledOnce();
    expect(home).not.toHaveBeenCalled();

    backOrHome({ canGoBack: false, back, home });
    expect(home).toHaveBeenCalledOnce();
  });
});

