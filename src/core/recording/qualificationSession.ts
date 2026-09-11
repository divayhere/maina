const QUALIFICATION_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUALIFICATION_EVIDENCE_DIGEST = /^[0-9a-f]{64}$/u;

export interface AndroidQualificationAuthorization {
  runId: string;
  evidenceDigest: string;
}

export function canonicalAndroidQualificationRunId(platform: string, value: unknown): string | null {
  return platform === 'android' && typeof value === 'string' && QUALIFICATION_RUN_ID.test(value)
    ? value.toLowerCase()
    : null;
}

export async function authorizeAndroidQualificationSession(
  requestedRunId: string | null,
  consume: (runId: string) => Promise<string | null>,
): Promise<AndroidQualificationAuthorization | null> {
  if (!requestedRunId) return null;
  const evidenceDigest = await consume(requestedRunId);
  if (!evidenceDigest || !QUALIFICATION_EVIDENCE_DIGEST.test(evidenceDigest)) {
    throw new Error('Android qualification session was not privately authorized.');
  }
  return { runId: requestedRunId, evidenceDigest };
}
