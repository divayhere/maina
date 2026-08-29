import { describe, expect, it } from 'vitest';

import { getMainaDrawerDestinations, MAIN_TAB_DESTINATIONS } from './mkc-memory-navigation';

describe('MKC Memory navigation', () => {
  it('does not expose Memory when the feature is disabled', () => {
    expect(getMainaDrawerDestinations({ mobileMemorySurfaceV1: false }).map((item) => item.key))
      .toEqual(['settings', 'privacy', 'help']);
  });

  it('adds one drawer destination without changing Home or To-dos', () => {
    expect(getMainaDrawerDestinations({ mobileMemorySurfaceV1: true }).map((item) => item.key))
      .toEqual(['memory', 'settings', 'privacy', 'help']);
    expect(MAIN_TAB_DESTINATIONS).toEqual([
      { key: 'index', label: 'Home', icon: 'home-outline' },
      { key: 'todos', label: 'To-dos', icon: 'checkmark-circle-outline' },
    ]);
  });
});
