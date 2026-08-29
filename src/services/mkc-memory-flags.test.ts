import { describe, expect, it } from 'vitest';

import { resolveMkcMemoryFeatureFlags } from './mkc-memory-flags';

describe('MKC Memory feature flags', () => {
  it('keeps every Memory feature disabled by default', () => {
    expect(resolveMkcMemoryFeatureFlags({})).toEqual({
      mobileMemorySurfaceV1: false,
      mobileCloudMeetingsV1: false,
      mobileFrozenHandoffV1: false,
      mobileMemoryPulseV1: false,
      mobileSavedRecallsV1: false,
      mobileVerifiedLinksV1: false,
    });
  });

  it('enables only an explicitly true flag', () => {
    const flags = resolveMkcMemoryFeatureFlags({
      EXPO_PUBLIC_MOBILE_MEMORY_SURFACE_V1: 'true',
      EXPO_PUBLIC_MOBILE_MEMORY_PULSE_V1: 'false',
    });
    expect(flags.mobileMemorySurfaceV1).toBe(true);
    expect(flags.mobileMemoryPulseV1).toBe(false);
  });
});
