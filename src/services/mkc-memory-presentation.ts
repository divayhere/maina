import type { SmartRecallDefinitionV1 } from '@/contracts/mkc-memory-releases.generated';

import type { MkcMemoryReadError } from './mkc-memory-client';
import { smartRecallDeltaCount } from './mkc-memory-contract-core';

export const MKC_MEMORY_ROUTES = {
  home: '/memory',
  meetings: '/memory/meetings',
  pulse: '/memory/pulse',
  savedRecalls: '/memory/saved-recalls',
} as const;

export function describeMemoryFreshness(input: {
  source: 'network' | 'cache';
  fetchedAt: number;
  now?: number;
}): { label: string; stale: boolean } {
  if (input.source === 'network') return { label: 'Up to date', stale: false };
  const elapsedMinutes = Math.max(0, Math.floor(((input.now ?? Date.now()) - input.fetchedAt) / 60_000));
  if (elapsedMinutes < 1) return { label: 'Saved just now', stale: true };
  if (elapsedMinutes < 60) return { label: `Saved ${elapsedMinutes}m ago`, stale: true };
  const hours = Math.floor(elapsedMinutes / 60);
  return { label: `Saved ${hours}h ago`, stale: true };
}

export function describeSmartRecallDelta(
  delta: SmartRecallDefinitionV1['last_delta'],
): { label: string; tone: 'muted' | 'primary' | 'warn' } {
  if (!delta) return { label: 'Not run yet', tone: 'muted' };
  if (!delta.comparable_to_previous) return { label: 'Refresh baseline', tone: 'warn' };
  const count = smartRecallDeltaCount(delta) ?? 0;
  if (count === 0) return { label: 'No identity changes', tone: 'muted' };
  return { label: `${count} identity change${count === 1 ? '' : 's'}`, tone: 'primary' };
}

export function memoryErrorAction(error: MkcMemoryReadError): {
  label: string;
  destination: '/settings' | null;
} {
  if (error.kind === 'auth' && /re-pair/i.test(error.message)) {
    return { label: 'Open Settings to re-pair', destination: '/settings' };
  }
  if (error.kind === 'auth') return { label: 'Open Settings', destination: '/settings' };
  return { label: 'Try again', destination: null };
}

export function memoryRouteForSource(sourceKey: string): string {
  return `/memory/meeting/${encodeURIComponent(sourceKey)}`;
}

export function memoryRouteForSavedRecall(definitionId: string): string {
  return `/memory/saved-recall/${encodeURIComponent(definitionId)}`;
}

export function memoryRouteForFrozenRecall(searchId: string): string {
  return `/memory/recall/${encodeURIComponent(searchId)}`;
}
