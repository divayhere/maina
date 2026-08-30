/* eslint-disable import/first -- the native fetch boundary must be mocked before import. */
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('expo/fetch', () => ({ fetch: mocks.fetch }));

import {
  MainaCloudApiError,
  MainaCloudRequestCancelledError,
  rejectedMainaCloudResponse,
  requestMainaCloudJson,
} from './mainaCloudTransport';

function abortError() {
  const error = new Error('synthetic raw request details must not escape');
  error.name = 'AbortError';
  return error;
}

function stalledBodyResponse(status = 200) {
  return (_url: string, init?: RequestInit) => Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    text: () => new Promise<string>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(abortError());
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
  });
}

describe('Maina Cloud finite JSON transport', () => {
  it('keeps the product deadline active after headers while the body stalls', async () => {
    mocks.fetch.mockImplementation(stalledBodyResponse());

    await expect(requestMainaCloudJson({
      url: 'https://example.invalid/v1/meeting-packets/job',
      timeoutMs: 5,
    })).rejects.toEqual(expect.objectContaining({
      name: 'MainaCloudApiError',
      status: 0,
      failureClass: 'timeout',
      message: 'Waiting for internet. Maina will continue automatically.',
    } satisfies Partial<MainaCloudApiError>));
  });

  it('allows a complete body immediately before the deadline', async () => {
    mocks.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ status: 'ready' }),
    });

    await expect(requestMainaCloudJson({
      url: 'https://example.invalid/v1/meeting-packets/job',
      timeoutMs: 50,
    })).resolves.toEqual({ status: 200, ok: true, data: { status: 'ready' } });
  });

  it('composes caller cancellation without disabling the product deadline', async () => {
    mocks.fetch.mockImplementation(stalledBodyResponse());
    const caller = new AbortController();
    const request = requestMainaCloudJson({
      url: 'https://example.invalid/v1/meetings',
      init: { signal: caller.signal },
      timeoutMs: 1_000,
    });
    caller.abort();

    await expect(request).rejects.toBeInstanceOf(MainaCloudRequestCancelledError);
  });

  it('also bounds non-2xx error-body consumption and never exposes raw causes', async () => {
    mocks.fetch.mockImplementation(stalledBodyResponse(503));

    await expect(requestMainaCloudJson({
      url: 'https://private-host.example/v1/sources',
      timeoutMs: 5,
    })).rejects.toEqual(expect.objectContaining({
      name: 'MainaCloudApiError',
      failureClass: 'timeout',
      message: expect.not.stringContaining('private-host.example'),
    }));
  });

  it.each([429, 503])('preserves HTTP %s when a gateway returns malformed non-JSON', async (status) => {
    mocks.fetch.mockResolvedValue({
      status,
      ok: false,
      text: async () => '<html>private upstream failure detail</html>',
    });

    const response = await requestMainaCloudJson({
      url: 'https://private-host.example/v1/meeting-packets/job',
    });
    const failure = rejectedMainaCloudResponse(response);

    expect(response).toEqual({ status, ok: false, data: null });
    expect(failure).toEqual(expect.objectContaining({
      status,
      failureClass: 'http_retryable',
      message: expect.not.stringContaining('private upstream failure detail'),
    }));
  });

  it('keeps malformed JSON on a successful JSON endpoint as a protocol failure', async () => {
    mocks.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => 'not-json and never safe to persist',
    });

    await expect(requestMainaCloudJson({
      url: 'https://example.invalid/v1/meeting-packets/job',
    })).rejects.toEqual(expect.objectContaining({
      status: 200,
      failureClass: 'protocol',
      code: 'invalid_json_response',
      message: expect.not.stringContaining('not-json'),
    }));
  });
});
