/* eslint-disable import/first -- Vitest mocks must be declared before importing the module under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import example from '../../contracts/mkc-meeting-tags/maina-meeting-tags.v1.json';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  requireScope: vi.fn(),
  pinExecutionContext: vi.fn(),
}));

vi.mock('./mainaCloudSession', () => ({
  MainaCloudApiError: class MainaCloudApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  },
  MainaCloudSessionMismatchError: class MainaCloudSessionMismatchError extends Error {},
  MainaCloudScopeError: class MainaCloudScopeError extends Error {},
  mainaCloudRequestJson: mocks.request,
  pinMainaCloudExecutionContext: mocks.pinExecutionContext,
  requireMainaCloudScope: mocks.requireScope,
}));

import {
  MkcMeetingTagsError,
  listMkcMeetingTags,
  mutateMkcMeetingTags,
  readMkcMeetingTagState,
} from './mkc-meeting-tags';

const definitions = {
  schema_version: 'mkc.meeting-tag-definitions.v1',
  definitions: example.definitions,
};
const session = {
  accessToken: 'credential-1',
  scopes: ['sources:read', 'sources:write'],
  scopesVerifiedAt: 1,
  user: { userId: 'owner-1', email: 'owner-1@maina.local' },
};
const executionContext = {
  ownerUserId: 'owner-1',
  accessToken: 'credential-1',
  scopesVerifiedAt: 1,
};

describe('MKC meeting-tags client boundary', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.requireScope.mockReset().mockResolvedValue(session);
    mocks.pinExecutionContext.mockReset().mockReturnValue(executionContext);
  });

  it('is default-off before scope or transport access', async () => {
    await expect(listMkcMeetingTags()).rejects.toEqual(expect.objectContaining({
      kind: 'disabled', retryable: false,
    } satisfies Partial<MkcMeetingTagsError>));
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('lists definitions with sources:read and strict decoding', async () => {
    mocks.request.mockResolvedValue({ status: 200, ok: true, data: definitions });
    await expect(listMkcMeetingTags({ enabled: true })).resolves.toEqual(definitions);
    expect(mocks.requireScope).toHaveBeenCalledWith('sources:read');
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/meeting-tags',
      expect.objectContaining({ method: 'GET' }),
      { executionContext },
    );

    mocks.request.mockResolvedValue({ status: 200, ok: true, data: { ...definitions, private_owner: 'leak' } });
    await expect(listMkcMeetingTags({ enabled: true })).rejects.toEqual(expect.objectContaining({
      kind: 'protocol', retryable: false,
    } satisfies Partial<MkcMeetingTagsError>));
  });

  it('encodes one source identity and rejects response identity drift', async () => {
    mocks.request.mockResolvedValue({ status: 200, ok: true, data: example.meeting_tag_state });
    await expect(readMkcMeetingTagState(example.meeting_tag_state.source_key, { enabled: true }))
      .resolves.toEqual(example.meeting_tag_state);
    expect(mocks.requireScope).toHaveBeenCalledWith('sources:read');
    expect(mocks.request).toHaveBeenCalledWith(
      `/v1/meetings/${encodeURIComponent(example.meeting_tag_state.source_key)}/tags`,
      expect.objectContaining({ method: 'GET' }),
      { executionContext },
    );

    mocks.request.mockResolvedValue({
      status: 200,
      ok: true,
      data: { ...example.meeting_tag_state, meeting_id: 'meeting:other', source_key: 'meeting:other' },
    });
    await expect(readMkcMeetingTagState(example.meeting_tag_state.source_key, { enabled: true }))
      .rejects.toEqual(expect.objectContaining({ kind: 'protocol' } satisfies Partial<MkcMeetingTagsError>));

    mocks.request.mockClear();
    mocks.requireScope.mockClear();
    await expect(readMkcMeetingTagState(` ${example.meeting_tag_state.source_key}`, { enabled: true }))
      .rejects.toEqual(expect.objectContaining({ kind: 'invalid' } satisfies Partial<MkcMeetingTagsError>));
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('validates before mutation, uses sources:write, and sends one exact request', async () => {
    mocks.request.mockResolvedValue({ status: 200, ok: true, data: example.remove_receipt });
    await expect(mutateMkcMeetingTags(example.remove_request, { enabled: true })).resolves.toEqual(example.remove_receipt);
    expect(mocks.requireScope).toHaveBeenCalledWith('sources:write');
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('/v1/meeting-tags/mutations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(example.remove_request),
    }), { executionContext });

    mocks.request.mockClear();
    mocks.requireScope.mockClear();
    await expect(mutateMkcMeetingTags({ ...example.remove_request, invented: 'unsafe' }, { enabled: true }))
      .rejects.toEqual(expect.objectContaining({ kind: 'protocol' } satisfies Partial<MkcMeetingTagsError>));
    expect(mocks.requireScope).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('passes cancellation to the bounded transport and never retries', async () => {
    const controller = new AbortController();
    mocks.request.mockResolvedValue({ status: 200, ok: true, data: definitions });
    await listMkcMeetingTags({ enabled: true, signal: controller.signal });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/meeting-tags',
      expect.objectContaining({ signal: controller.signal }),
      { executionContext },
    );
  });

  it('fails before transport when the exact mobile scope is unavailable', async () => {
    const ScopeError = (await import('./mainaCloudSession')).MainaCloudScopeError;
    mocks.requireScope.mockRejectedValue(new ScopeError('cloud_scope_unverified', 'scope missing'));
    await expect(listMkcMeetingTags({ enabled: true })).rejects.toEqual(expect.objectContaining({
      kind: 'auth', retryable: false,
    } satisfies Partial<MkcMeetingTagsError>));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects an owner-session switch at both pre-request seams', async () => {
    const executionContext = {
      ownerUserId: 'owner-a',
      accessToken: 'token-a',
      scopesVerifiedAt: 1,
    } as const;
    const SessionMismatch = (await import('./mainaCloudSession')).MainaCloudSessionMismatchError;

    mocks.requireScope.mockRejectedValueOnce(new SessionMismatch());
    await expect(mutateMkcMeetingTags(example.remove_request, {
      enabled: true,
      executionContext,
    })).rejects.toMatchObject({ kind: 'session_changed', retryable: true });
    expect(mocks.requireScope).toHaveBeenCalledWith('sources:write', executionContext);
    expect(mocks.request).not.toHaveBeenCalled();

    mocks.requireScope.mockResolvedValueOnce({ user: { userId: 'owner-a' } });
    mocks.request.mockRejectedValueOnce(new SessionMismatch());
    await expect(mutateMkcMeetingTags(example.remove_request, {
      enabled: true,
      executionContext,
    })).rejects.toMatchObject({ kind: 'session_changed', retryable: true });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith(
      '/v1/meeting-tags/mutations',
      expect.objectContaining({ method: 'POST' }),
      { executionContext },
    );
  });

  it.each([
    [401, 'session_expired', 'auth', false],
    [403, 'auth_forbidden', 'forbidden', false],
    [404, 'meeting_tag_not_found', 'not_found', false],
    [409, 'meeting_tag_revision_conflict', 'conflict', false],
    [422, 'meeting_tag_label_invalid', 'invalid', false],
    [503, 'meeting_tag_mutation_unavailable', 'retryable', true],
    [503, 'meeting_tag_revision_conflict', 'retryable', true],
    [429, 'meeting_tag_label_invalid', 'retryable', true],
    [0, 'network_error', 'offline', true],
  ] as const)('maps HTTP %s/%s to a sanitized failure', async (status, code, kind, retryable) => {
    const CloudError = (await import('./mainaCloudSession')).MainaCloudApiError;
    mocks.request.mockRejectedValue(new CloudError('private backend detail', status, code));
    await expect(listMkcMeetingTags({ enabled: true })).rejects.toEqual(expect.objectContaining({
      kind, retryable, message: expect.not.stringContaining('private backend detail'),
    } satisfies Partial<MkcMeetingTagsError>));
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
