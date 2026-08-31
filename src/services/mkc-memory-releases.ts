import type {
  MemoryPulseV1,
  MemoryPulseViewedV1,
  SmartRecallDefinitionV1,
  SmartRecallListV1,
  SmartRecallRunV1,
} from '@/contracts/mkc-memory-releases.generated';

import {
  decodeMemoryPulse,
  decodeMemoryPulseViewed,
  decodeSmartRecallDefinition,
  decodeSmartRecallList,
  decodeSmartRecallRun,
  MkcMemoryContractError,
} from './mkc-memory-contract-core';
import {
  MkcMemoryReadError,
  mutateMkcMemory,
  readCachedMkcMemory,
  type MkcMemoryReadResult,
} from './mkc-memory-client';
import { MKC_MEMORY_FEATURE_FLAGS } from './mkc-memory-flags';

function contractError(cause: unknown): MkcMemoryReadError | null {
  if (cause instanceof MkcMemoryContractError) {
    return new MkcMemoryReadError('integrity', false, 'Maina could not verify this memory safely.');
  }
  return null;
}

export function resolveMemoryTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getMemoryPulse(input: {
  timezone?: string;
  enabled?: boolean;
  signal?: AbortSignal;
} = {}): Promise<MkcMemoryReadResult<MemoryPulseV1>> {
  const timezone = input.timezone?.trim() || resolveMemoryTimezone();
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileMemoryPulseV1,
    disabledMessage: 'Memory Pulse is not enabled in this build.',
    path: `/v1/memory-pulse?timezone=${encodeURIComponent(timezone)}`,
    kind: 'pulse',
    scope: { timezone },
    decode: decodeMemoryPulse,
    mapContractError: contractError,
    signal: input.signal,
  });
}

export function markMemoryPulseViewed(input: {
  observedAt: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<MemoryPulseViewedV1> {
  return mutateMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileMemoryPulseV1,
    disabledMessage: 'Memory Pulse is not enabled in this build.',
    path: '/v1/memory-pulse/viewed',
    body: { observed_at: input.observedAt },
    decode: decodeMemoryPulseViewed,
    mapContractError: contractError,
    signal: input.signal,
  });
}

export function listSavedSmartRecalls(input: {
  enabled?: boolean;
  signal?: AbortSignal;
} = {}): Promise<MkcMemoryReadResult<SmartRecallListV1>> {
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1,
    disabledMessage: 'Saved Recalls are not enabled in this build.',
    path: '/v1/smart-recalls',
    kind: 'saved-recalls',
    scope: { resource: 'list' },
    decode: decodeSmartRecallList,
    mapContractError: contractError,
    signal: input.signal,
  });
}

export function getSavedSmartRecall(input: {
  definitionId: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<MkcMemoryReadResult<SmartRecallDefinitionV1>> {
  return readCachedMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1,
    disabledMessage: 'Saved Recalls are not enabled in this build.',
    path: `/v1/smart-recalls/${encodeURIComponent(input.definitionId)}`,
    kind: 'saved-recalls',
    scope: { resource: 'detail', definitionId: input.definitionId },
    decode: (body) => decodeSmartRecallDefinition(body, input.definitionId),
    checksum: (data) => data.last_bundle_sha256,
    mapContractError: contractError,
    signal: input.signal,
  });
}

function runSavedSmartRecallAction(input: {
  definitionId: string;
  action: 'run' | 'prepare';
  timezone?: string;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<SmartRecallRunV1> {
  return mutateMkcMemory({
    enabled: input.enabled,
    defaultEnabled: MKC_MEMORY_FEATURE_FLAGS.mobileSavedRecallsV1,
    disabledMessage: 'Saved Recalls are not enabled in this build.',
    path: `/v1/smart-recalls/${encodeURIComponent(input.definitionId)}/${input.action}`,
    body: { timezone: input.timezone?.trim() || resolveMemoryTimezone() },
    decode: (body) => decodeSmartRecallRun(body, input.definitionId),
    mapContractError: contractError,
    signal: input.signal,
  });
}

export function runSavedSmartRecall(input: Omit<Parameters<typeof runSavedSmartRecallAction>[0], 'action'>) {
  return runSavedSmartRecallAction({ ...input, action: 'run' });
}

export function prepareSavedSmartRecall(input: Omit<Parameters<typeof runSavedSmartRecallAction>[0], 'action'>) {
  return runSavedSmartRecallAction({ ...input, action: 'prepare' });
}
