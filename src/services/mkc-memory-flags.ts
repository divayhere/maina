export type MkcMemoryFeatureFlags = {
  mobileMemorySurfaceV1: boolean;
  mobileCloudMeetingsV1: boolean;
  mobileFrozenHandoffV1: boolean;
  mobileMemoryPulseV1: boolean;
  mobileSavedRecallsV1: boolean;
  mobileVerifiedLinksV1: boolean;
};

type FlagEnvironment = Partial<Record<
  | 'EXPO_PUBLIC_MOBILE_MEMORY_SURFACE_V1'
  | 'EXPO_PUBLIC_MOBILE_CLOUD_MEETINGS_V1'
  | 'EXPO_PUBLIC_MOBILE_FROZEN_HANDOFF_V1'
  | 'EXPO_PUBLIC_MOBILE_MEMORY_PULSE_V1'
  | 'EXPO_PUBLIC_MOBILE_SAVED_RECALLS_V1'
  | 'EXPO_PUBLIC_MOBILE_VERIFIED_LINKS_V1',
  string | undefined
>>;

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function resolveMkcMemoryFeatureFlags(environment: FlagEnvironment): MkcMemoryFeatureFlags {
  return {
    mobileMemorySurfaceV1: enabled(environment.EXPO_PUBLIC_MOBILE_MEMORY_SURFACE_V1),
    mobileCloudMeetingsV1: enabled(environment.EXPO_PUBLIC_MOBILE_CLOUD_MEETINGS_V1),
    mobileFrozenHandoffV1: enabled(environment.EXPO_PUBLIC_MOBILE_FROZEN_HANDOFF_V1),
    mobileMemoryPulseV1: enabled(environment.EXPO_PUBLIC_MOBILE_MEMORY_PULSE_V1),
    mobileSavedRecallsV1: enabled(environment.EXPO_PUBLIC_MOBILE_SAVED_RECALLS_V1),
    mobileVerifiedLinksV1: enabled(environment.EXPO_PUBLIC_MOBILE_VERIFIED_LINKS_V1),
  };
}

export const MKC_MEMORY_FEATURE_FLAGS = resolveMkcMemoryFeatureFlags({
  EXPO_PUBLIC_MOBILE_MEMORY_SURFACE_V1: process.env.EXPO_PUBLIC_MOBILE_MEMORY_SURFACE_V1,
  EXPO_PUBLIC_MOBILE_CLOUD_MEETINGS_V1: process.env.EXPO_PUBLIC_MOBILE_CLOUD_MEETINGS_V1,
  EXPO_PUBLIC_MOBILE_FROZEN_HANDOFF_V1: process.env.EXPO_PUBLIC_MOBILE_FROZEN_HANDOFF_V1,
  EXPO_PUBLIC_MOBILE_MEMORY_PULSE_V1: process.env.EXPO_PUBLIC_MOBILE_MEMORY_PULSE_V1,
  EXPO_PUBLIC_MOBILE_SAVED_RECALLS_V1: process.env.EXPO_PUBLIC_MOBILE_SAVED_RECALLS_V1,
  EXPO_PUBLIC_MOBILE_VERIFIED_LINKS_V1: process.env.EXPO_PUBLIC_MOBILE_VERIFIED_LINKS_V1,
});
