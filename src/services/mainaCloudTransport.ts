import { fetch as expoFetch } from 'expo/fetch';

import {
  classifyHttpFailure,
  classifyTransportCause,
  safeCloudFailureMessage,
} from '@/core/pipeline/cloudFailure';
import type { CloudFailureClass } from '@/data/meetings';

export const MAINA_CLOUD_REQUEST_TIMEOUT_MS = 20_000;

export class MainaCloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly failureClass: CloudFailureClass = status > 0
      ? classifyHttpFailure(status, code)
      : 'transport_unknown',
  ) {
    super(message);
    this.name = 'MainaCloudApiError';
  }
}

export class MainaCloudRequestCancelledError extends Error {
  constructor() {
    super('The Maina Cloud request was cancelled.');
    this.name = 'MainaCloudRequestCancelledError';
  }
}

export type MainaCloudJsonResponse = {
  status: number;
  ok: boolean;
  data: unknown;
};

function errorCode(body: unknown): string | undefined {
  const candidate = body as { error?: { code?: unknown } } | null;
  return typeof candidate?.error?.code === 'string' ? candidate.error.code : undefined;
}

function decodeJson(text: string, response: { ok: boolean; status: number }): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // HTTP status remains authoritative for rejected responses. Gateways may
    // legitimately return HTML or an empty/non-JSON body for 429/5xx. Keep the
    // body private and let rejectedMainaCloudResponse classify the real status.
    if (!response.ok) return null;
    throw new MainaCloudApiError(
      safeCloudFailureMessage('protocol'),
      response.status,
      'invalid_json_response',
      'protocol',
    );
  }
}

/**
 * One finite transport boundary for every MKC JSON call. The deadline remains
 * armed until expo/fetch has consumed the complete response body and JSON has
 * been decoded. A caller signal is forwarded into the same controller; it can
 * never replace the product deadline.
 */
export async function requestMainaCloudJson(input: {
  url: string;
  init?: RequestInit;
  timeoutMs?: number;
}): Promise<MainaCloudJsonResponse> {
  const callerSignal = input.init?.signal ?? null;
  if (callerSignal?.aborted) throw new MainaCloudRequestCancelledError();

  const controller = new AbortController();
  let abortOwner: 'deadline' | 'caller' | null = null;
  const onCallerAbort = () => {
    if (abortOwner == null) abortOwner = 'caller';
    controller.abort();
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => {
    if (abortOwner == null) abortOwner = 'deadline';
    controller.abort();
  }, Math.max(1, input.timeoutMs ?? MAINA_CLOUD_REQUEST_TIMEOUT_MS));

  try {
    const response = await expoFetch(input.url, {
      ...input.init,
      signal: controller.signal,
    });
    // Keep the controller/timer alive through the body read. expo/fetch binds
    // this promise to the same AbortSignal on both native platforms.
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      data: decodeJson(text, response),
    };
  } catch (cause) {
    if (cause instanceof MainaCloudApiError || cause instanceof MainaCloudRequestCancelledError) {
      throw cause;
    }
    if (abortOwner === 'caller') throw new MainaCloudRequestCancelledError();
    const failureClass: CloudFailureClass = abortOwner === 'deadline'
      ? 'timeout'
      : classifyTransportCause(cause);
    throw new MainaCloudApiError(
      safeCloudFailureMessage(failureClass),
      0,
      failureClass === 'timeout' ? 'network_timeout' : 'network_error',
      failureClass,
    );
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

export function rejectedMainaCloudResponse(response: MainaCloudJsonResponse): MainaCloudApiError {
  const code = errorCode(response.data);
  const failureClass = classifyHttpFailure(response.status, code);
  return new MainaCloudApiError(
    safeCloudFailureMessage(failureClass),
    response.status,
    code,
    failureClass,
  );
}
