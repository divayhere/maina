import { describe, expect, it, vi } from 'vitest';

import {
  authorizeAndroidQualificationSession,
  canonicalAndroidQualificationRunId,
} from './qualificationSession';

const runId = '00000000-0000-4000-8000-000000000001';
const evidenceDigest = 'a'.repeat(64);

describe('Android qualification session authority', () => {
  it('does not treat a public UUID as authorization', async () => {
    const consume = vi.fn(async () => null);
    await expect(authorizeAndroidQualificationSession(runId, consume)).rejects.toThrow('not privately authorized');
    expect(consume).toHaveBeenCalledOnce();
  });

  it('accepts the exact one-time native consume result', async () => {
    const consume = vi.fn(async () => evidenceDigest);
    await expect(authorizeAndroidQualificationSession(runId, consume)).resolves.toEqual({ runId, evidenceDigest });
    expect(consume).toHaveBeenCalledWith(runId);
  });

  it('rejects malformed native evidence even after a nominal consume', async () => {
    const consume = vi.fn(async () => 'A'.repeat(64));
    await expect(authorizeAndroidQualificationSession(runId, consume)).rejects.toThrow('not privately authorized');
  });

  it('keeps ordinary and malformed routes outside qualification mode', async () => {
    expect(canonicalAndroidQualificationRunId('ios', runId)).toBeNull();
    expect(canonicalAndroidQualificationRunId('android', `${runId}-extra`)).toBeNull();
    const consume = vi.fn(async () => evidenceDigest);
    await expect(authorizeAndroidQualificationSession(null, consume)).resolves.toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });
});
