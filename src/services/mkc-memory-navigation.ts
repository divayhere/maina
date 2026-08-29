import type { MkcMemoryFeatureFlags } from './mkc-memory-flags';

export type MainaDrawerDestination = {
  key: 'memory' | 'settings' | 'privacy' | 'help';
  label: string;
  icon: 'sparkles-outline' | 'settings-outline' | 'shield-checkmark-outline' | 'help-circle-outline';
  href: '/memory' | '/settings' | '/help';
};

export const MAIN_TAB_DESTINATIONS = [
  { key: 'index', label: 'Home', icon: 'home-outline' },
  { key: 'todos', label: 'To-dos', icon: 'checkmark-circle-outline' },
] as const;

const BASE_DRAWER_DESTINATIONS: readonly MainaDrawerDestination[] = [
  { key: 'settings', label: 'Settings', icon: 'settings-outline', href: '/settings' },
  { key: 'privacy', label: 'Privacy & storage', icon: 'shield-checkmark-outline', href: '/settings' },
  { key: 'help', label: 'Help', icon: 'help-circle-outline', href: '/help' },
];

export function getMainaDrawerDestinations(
  flags: Pick<MkcMemoryFeatureFlags, 'mobileMemorySurfaceV1'>,
): readonly MainaDrawerDestination[] {
  if (!flags.mobileMemorySurfaceV1) return BASE_DRAWER_DESTINATIONS;
  return [
    { key: 'memory', label: 'Memory', icon: 'sparkles-outline', href: '/memory' },
    ...BASE_DRAWER_DESTINATIONS,
  ];
}
