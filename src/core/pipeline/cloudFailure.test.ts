import { describe, expect, it } from 'vitest';

import {
  classifyHttpFailure,
  classifyTransportCause,
  isTransportFailure,
  safeCloudFailureMessage,
} from './cloudFailure';

describe('typed cloud failures', () => {
  it('classifies transport errors without exposing their raw text', () => {
    expect(classifyTransportCause(new Error('java.net.UnknownHostException: private.example'))).toBe('dns');
    expect(classifyTransportCause(new Error('SSL certificate failed'))).toBe('tls');
    expect(classifyTransportCause(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('timeout');
    expect(isTransportFailure('dns')).toBe(true);
    expect(safeCloudFailureMessage('dns')).not.toContain('example');
    expect(safeCloudFailureMessage('dns')).not.toContain('UnknownHostException');
  });

  it('keeps provider and transport retry classes distinct', () => {
    expect(classifyHttpFailure(429)).toBe('rate_limited');
    expect(classifyHttpFailure(503)).toBe('http_5xx');
    expect(classifyHttpFailure(401)).toBe('auth');
    expect(isTransportFailure('rate_limited')).toBe(false);
  });
});

