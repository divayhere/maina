export type MkcMemoryResourceKind =
  | 'meeting-list'
  | 'meeting-detail'
  | 'meeting-transcript'
  | 'frozen-recall'
  | 'pulse'
  | 'saved-recalls';

export type MkcMemoryIntegrityState =
  | { state: 'verified' }
  | { state: 'owner-mismatch' }
  | { state: 'expired' }
  | { state: 'missing-checksum'; field: string }
  | { state: 'checksum-mismatch'; field: string };

export type MkcMemoryChecksum = {
  field: string;
  expected: string | null | undefined;
  received: string | null | undefined;
};

export function assessMkcMemoryIntegrity(input: {
  expectedOwnerUserId: string;
  receivedOwnerUserId: string | null | undefined;
  expiresAt?: string | null;
  checksums: readonly MkcMemoryChecksum[];
  now?: number;
}): MkcMemoryIntegrityState {
  if (!input.receivedOwnerUserId || input.receivedOwnerUserId !== input.expectedOwnerUserId) {
    return { state: 'owner-mismatch' };
  }
  if (input.expiresAt) {
    const expiresAt = Date.parse(input.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= (input.now ?? Date.now())) {
      return { state: 'expired' };
    }
  }
  for (const checksum of input.checksums) {
    if (!checksum.expected?.trim() || !checksum.received?.trim()) {
      return { state: 'missing-checksum', field: checksum.field };
    }
    if (checksum.expected !== checksum.received) {
      return { state: 'checksum-mismatch', field: checksum.field };
    }
  }
  return { state: 'verified' };
}

function stableScope(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableScope).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableScope(object[key])}`).join(',')}}`;
}

export function makeMkcMemoryCacheKey(input: {
  ownerUserId: string;
  kind: MkcMemoryResourceKind;
  scope: unknown;
}): string {
  const owner = input.ownerUserId.trim();
  if (!owner) throw new Error('Memory cache owner is required.');
  return `${encodeURIComponent(owner)}|${input.kind}|${stableScope(input.scope)}`;
}

export type MkcMemoryFailureKind = 'auth' | 'owner' | 'expired' | 'integrity' | 'offline' | 'invalid' | 'unknown';

export function classifyMkcMemoryFailure(input: {
  status?: number;
  code?: string;
}): { kind: MkcMemoryFailureKind; retryable: boolean; message: string } {
  const code = input.code?.toLowerCase() ?? '';
  if (input.status === 401) return { kind: 'auth', retryable: false, message: 'Reconnect Maina Cloud to continue.' };
  if (input.status === 403 || code.includes('owner')) return { kind: 'owner', retryable: false, message: 'This memory is not available to this account.' };
  if (input.status === 404 || code.includes('expired')) return { kind: 'expired', retryable: false, message: 'This saved memory is no longer available.' };
  if (code.includes('checksum') || code.includes('integrity')) return { kind: 'integrity', retryable: false, message: 'Maina could not verify this memory safely.' };
  if (input.status === 422 || code.includes('cursor') || code.includes('validation')) return { kind: 'invalid', retryable: false, message: 'This memory request is no longer valid.' };
  if (!input.status || code.includes('network') || code.includes('timeout')) return { kind: 'offline', retryable: true, message: 'Showing saved information until Maina Cloud reconnects.' };
  return { kind: 'unknown', retryable: input.status >= 500, message: 'Maina Cloud could not load this memory.' };
}
