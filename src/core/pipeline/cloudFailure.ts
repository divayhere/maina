import type { CloudFailureClass } from '@/data/meetings';

export type CloudFailureOperation =
  | 'create_job'
  | 'poll_job'
  | 'retry_provider'
  | 'sync_source';

const TRANSPORT_FAILURES = new Set<CloudFailureClass>([
  'offline',
  'dns',
  'tls',
  'socket',
  'timeout',
]);

function normalizedMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message.toLowerCase() : String(cause ?? '').toLowerCase();
}

export function classifyTransportCause(cause: unknown): CloudFailureClass {
  const name = cause instanceof Error ? cause.name.toLowerCase() : '';
  const message = normalizedMessage(cause);
  if (name === 'aborterror' || message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('unknownhost') || message.includes('enotfound') || message.includes('dns')) return 'dns';
  if (message.includes('ssl') || message.includes('tls') || message.includes('certificate')) return 'tls';
  if (message.includes('network request failed') || message.includes('offline') || message.includes('not connected')) return 'offline';
  if (message.includes('socket') || message.includes('econn') || message.includes('connection reset')) return 'socket';
  return 'unknown';
}

export function classifyHttpFailure(status: number, code?: string | null): CloudFailureClass {
  const normalizedCode = code?.toLowerCase() ?? '';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (normalizedCode.includes('budget')) return 'budget';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'unknown';
}

export function isTransportFailure(value: CloudFailureClass | null | undefined): boolean {
  return !!value && TRANSPORT_FAILURES.has(value);
}

export function safeCloudFailureMessage(value: CloudFailureClass): string {
  switch (value) {
    case 'auth':
      return 'Maina Cloud needs to be reconnected. Your recording and transcript are safe.';
    case 'validation':
    case 'conflict':
      return 'Maina Cloud could not accept this meeting yet. Your local copy is safe.';
    case 'budget':
      return 'Cloud sync is paused. Maina will keep your local meeting safe and retry when available.';
    case 'rate_limited':
    case 'provider_retryable':
      return 'Cloud processing is busy. Maina will retry automatically.';
    case 'http_4xx':
      return 'Maina Cloud could not process this request. Your local meeting is safe.';
    default:
      return 'Waiting for internet. Maina will continue automatically.';
  }
}

export function safePersistedCloudMessage(
  message: string | null | undefined,
  fallback: string,
): string {
  const value = message?.trim();
  if (!value) return fallback;
  const unsafe = /https?:\/\/|unknownhost|exception|socket|ssl|tls|bearer|token|workers\.dev|provider/i.test(value);
  return unsafe ? fallback : value;
}
