import { describe, expect, it } from 'vitest';

import type { SmartRecallDefinitionV1 } from '@/contracts/mkc-memory-releases.generated';

import type { MkcMemoryReadError } from './mkc-memory-client';
import {
  describeMemoryFreshness,
  describeSmartRecallDelta,
  memoryErrorAction,
  memoryRouteForFrozenRecall,
  memoryRouteForSavedRecall,
  memoryRouteForSource,
} from './mkc-memory-presentation';
import { buildMkcMemoryWebUrl } from './mkc-memory-web';

describe('Memory mobile presentation truth', () => {
  it('labels offline cache as stale with a visible age', () => {
    expect(describeMemoryFreshness({ source: 'cache', fetchedAt: 1_000, now: 3_601_000 })).toEqual({ label: 'Saved 1h ago', stale: true });
    expect(describeMemoryFreshness({ source: 'network', fetchedAt: 1_000 })).toEqual({ label: 'Up to date', stale: false });
  });

  it('never invents a change count when the backend says results are not comparable', () => {
    const delta = { comparable_to_previous: false, comparability_reason: 'planner_version_changed' } as SmartRecallDefinitionV1['last_delta'];
    expect(describeSmartRecallDelta(delta)).toEqual({ label: 'Refresh baseline', tone: 'warn' });
  });

  it('sends legacy sessions to re-pair and keeps ordinary failures on retry', () => {
    expect(memoryErrorAction({ kind: 'auth', retryable: false, message: 'Re-pair this phone in Settings.' } as MkcMemoryReadError)).toEqual({
      label: 'Open Settings to re-pair', destination: '/settings',
    });
    expect(memoryErrorAction({ kind: 'offline', retryable: true, message: 'Offline.' } as MkcMemoryReadError)).toEqual({ label: 'Try again', destination: null });
  });

  it('encodes native routes and authenticated Web fallbacks without tokens', () => {
    expect(memoryRouteForSource('meeting:one/two')).toBe('/memory/meeting/meeting%3Aone%2Ftwo');
    expect(memoryRouteForSavedRecall('recall/one')).toBe('/memory/saved-recall/recall%2Fone');
    expect(memoryRouteForFrozenRecall('search one')).toBe('/memory/recall/search%20one');
    const urls = [
      buildMkcMemoryWebUrl({ kind: 'source', sourceKey: 'source/one' }),
      buildMkcMemoryWebUrl({ kind: 'recall', searchId: 'search one' }),
      buildMkcMemoryWebUrl({ kind: 'saved-recall', definitionId: 'saved/one' }),
    ];
    expect(urls).toEqual([
      'https://maina-knowledge-cloud-web.maina-knowledge-cloud.workers.dev/source/source%2Fone',
      'https://maina-knowledge-cloud-web.maina-knowledge-cloud.workers.dev/recall?search_id=search%20one',
      'https://maina-knowledge-cloud-web.maina-knowledge-cloud.workers.dev/smart-recalls/saved%2Fone',
    ]);
    expect(urls.join('')).not.toMatch(/token|access_token/i);
  });
});
