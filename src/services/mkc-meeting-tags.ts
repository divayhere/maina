import type {
  MeetingTagDefinitionListV1,
  MeetingTagMutationReceiptV1,
  MeetingTagMutationRequestV1,
  MeetingTagStateV1,
} from '@/contracts/mkc-meeting-tags.generated';
import {
  MainaCloudApiError,
  MainaCloudScopeError,
  mainaCloudRequestJson,
  requireMainaCloudScope,
} from './mainaCloudSession';
import {
  MkcMeetingTagContractError,
  decodeMeetingTagDefinitions,
  decodeMeetingTagMutationReceipt,
  decodeMeetingTagMutationRequest,
  decodeMeetingTagState,
} from './mkc-meeting-tags-core';
import { MKC_MEMORY_FEATURE_FLAGS } from './mkc-memory-flags';

export type MkcMeetingTagsFailureKind =
  | 'disabled'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'offline'
  | 'retryable'
  | 'protocol';

export class MkcMeetingTagsError extends Error {
  constructor(
    readonly kind: MkcMeetingTagsFailureKind,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MkcMeetingTagsError';
  }
}

type RequestBoundary = {
  enabled?: boolean;
  signal?: AbortSignal;
};

function requireEnabled(enabled: boolean | undefined): void {
  if (!(enabled ?? MKC_MEMORY_FEATURE_FLAGS.mobileMeetingTagsV1)) {
    throw new MkcMeetingTagsError(
      'disabled',
      false,
      'Meeting tags are not available in this build.',
    );
  }
}

function safeError(cause: unknown): MkcMeetingTagsError {
  if (cause instanceof MkcMeetingTagsError) return cause;
  if (cause instanceof MkcMeetingTagContractError) {
    return new MkcMeetingTagsError('protocol', false, 'Maina could not verify the meeting-tag response safely.');
  }
  if (cause instanceof MainaCloudScopeError) {
    return new MkcMeetingTagsError('auth', false, 'Reconnect Maina Cloud to use meeting tags.');
  }
  if (!(cause instanceof MainaCloudApiError)) {
    return new MkcMeetingTagsError('offline', true, 'Meeting tags will be available when Maina Cloud reconnects.');
  }
  const code = cause.code ?? '';
  if (cause.status === 401) return new MkcMeetingTagsError('auth', false, 'Reconnect Maina Cloud to use meeting tags.');
  if (cause.status === 403) return new MkcMeetingTagsError('forbidden', false, 'This phone cannot access meeting tags.');
  if (cause.status === 404 || code === 'meeting_tag_not_found') {
    return new MkcMeetingTagsError('not_found', false, 'This meeting tag is not available.');
  }
  if (cause.status === 409 || code === 'meeting_tag_label_conflict'
    || code === 'meeting_tag_revision_conflict' || code === 'meeting_tag_idempotency_conflict') {
    return new MkcMeetingTagsError('conflict', false, 'Meeting tags changed elsewhere. Refresh and try again.');
  }
  if (cause.status === 422 || code === 'meeting_tag_label_invalid') {
    return new MkcMeetingTagsError('invalid', false, 'This meeting-tag change is not valid.');
  }
  if (cause.status === 0) {
    return new MkcMeetingTagsError('offline', true, 'Meeting tags will be available when Maina Cloud reconnects.');
  }
  if (cause.status === 429 || cause.status >= 500
    || code === 'meeting_tag_mutation_unavailable' || code === 'meeting_tag_read_unavailable') {
    return new MkcMeetingTagsError('retryable', true, 'Meeting tags are temporarily unavailable.');
  }
  return new MkcMeetingTagsError('protocol', false, 'Maina could not complete the meeting-tag request safely.');
}

async function requireScope(scope: 'sources:read' | 'sources:write'): Promise<void> {
  try {
    await requireMainaCloudScope(scope);
  } catch (cause) {
    throw safeError(cause);
  }
}

function sourceKeyPath(sourceKey: string): string {
  if (sourceKey.trim() !== sourceKey || sourceKey.length < 1 || sourceKey.length > 200) {
    throw new MkcMeetingTagsError('invalid', false, 'The meeting identity is not valid.');
  }
  return `/v1/meetings/${encodeURIComponent(sourceKey)}/tags`;
}

export async function listMkcMeetingTags(
  boundary: RequestBoundary = {},
): Promise<MeetingTagDefinitionListV1> {
  requireEnabled(boundary.enabled);
  await requireScope('sources:read');
  try {
    const response = await mainaCloudRequestJson('/v1/meeting-tags', {
      method: 'GET',
      signal: boundary.signal,
    });
    return decodeMeetingTagDefinitions(response.data);
  } catch (cause) {
    throw safeError(cause);
  }
}

export async function readMkcMeetingTagState(
  sourceKey: string,
  boundary: RequestBoundary = {},
): Promise<MeetingTagStateV1> {
  requireEnabled(boundary.enabled);
  const path = sourceKeyPath(sourceKey);
  await requireScope('sources:read');
  try {
    const response = await mainaCloudRequestJson(path, {
      method: 'GET',
      signal: boundary.signal,
    });
    return decodeMeetingTagState(response.data, sourceKey);
  } catch (cause) {
    throw safeError(cause);
  }
}

export async function mutateMkcMeetingTags(
  requestValue: unknown,
  boundary: RequestBoundary = {},
): Promise<MeetingTagMutationReceiptV1> {
  requireEnabled(boundary.enabled);
  let request: MeetingTagMutationRequestV1;
  try {
    request = decodeMeetingTagMutationRequest(requestValue);
  } catch (cause) {
    throw safeError(cause);
  }
  await requireScope('sources:write');
  try {
    const response = await mainaCloudRequestJson('/v1/meeting-tags/mutations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: boundary.signal,
    });
    return decodeMeetingTagMutationReceipt(response.data, request);
  } catch (cause) {
    throw safeError(cause);
  }
}
