import { describe, expect, it } from 'vitest';

import {
  classifyHttpFailure,
  classifyTransportCause,
  isTransportFailure,
  safeCloudFailureMessage,
  safePersistedCloudMessage,
} from './cloudFailure';

describe('typed cloud failure handling', () => {
  it('uses typed names/codes and never human error text', () => {
    expect(classifyTransportCause(Object.assign(new Error('private host'), { code: 'ENOTFOUND' }))).toBe('dns');
    expect(classifyTransportCause(Object.assign(new Error('anything'), { name: 'AbortError' }))).toBe('timeout');
    expect(classifyTransportCause(Object.assign(new Error('certificate words only'), { code: 'OTHER' }))).toBe('transport_unknown');
    expect(classifyTransportCause(new Error('java.net.UnknownHostException: private.example'))).toBe('transport_unknown');
  });

  it('keeps backend/provider backoff separate from transport reconnect', () => {
    expect(classifyHttpFailure(429)).toBe('http_retryable');
    expect(classifyHttpFailure(503, 'budget_guardrail_blocked')).toBe('backend_retryable');
    expect(classifyHttpFailure(422, 'validation_failed')).toBe('backend_terminal');
    expect(classifyHttpFailure(401)).toBe('auth');
    expect(isTransportFailure('http_retryable')).toBe(false);
    expect(isTransportFailure('transport_unknown')).toBe(true);
  });

  it('never returns raw exceptions, hosts, provider text, or tokens', () => {
    const fallback = safeCloudFailureMessage('transport_unknown');
    for (const raw of [
      'java.net.UnknownHostException: private.example',
      'https://private.workers.dev failed',
      'Bearer secret-token',
      'provider returned proprietary text',
    ]) {
      expect(safePersistedCloudMessage(raw, fallback)).toBe(fallback);
    }
  });
});
