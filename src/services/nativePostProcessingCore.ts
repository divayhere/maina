export type NativeTranscriptOutcome = {
  status: 'transcribed' | 'transcript_partial' | 'recorded';
  coverageComplete: boolean;
  error: string | null;
};

export type IOSNativePostProcessingReasonCode =
  | 'NONE'
  | 'MODEL_UNAVAILABLE'
  | 'RUNTIME_INTERRUPTED'
  | 'AUDIO_UNREADABLE'
  | 'RETRY_BUDGET_EXHAUSTED'
  | 'OWNER_RELEASED';

export type IOSNativePostProcessingResult = {
  schemaVersion: 'maina.native-post-processing-result.v1';
  identity: {
    ownerUserId: string;
    meetingId: string;
    runId: string;
    generation: number;
    resultId: string;
    audioFingerprintSha256: string;
    contractVersion: '1.0';
    modelId: string;
    modelVersion: string;
    runtimeVersion: string;
    createdAt: string;
  };
  disposition: 'complete' | 'partial';
  audio: { durationMs: number; segmentCount: number };
  windowConfig: { targetWindowMs: number; analysisOverlapMs: number; maxAttempts: number };
  windows: Array<{
    windowKey: string;
    index: number;
    coverageStartMs: number;
    coverageEndMs: number;
    analysisStartMs: number;
    analysisEndMs: number;
    status: 'completed' | 'failed' | 'unresolved';
    blocks: Array<{
      blockKey: string;
      sequence: number;
      startedAtMs: number;
      endedAtMs: number;
      text: string;
      language: string;
    }>;
    retry: {
      attemptCount: number;
      maxAttempts: number;
      lastReasonCode: IOSNativePostProcessingReasonCode;
    };
    vad: { status: 'speech' | 'silence' | 'unavailable'; evidenceSha256: string };
  }>;
  unresolvedIntervals: Array<{
    windowKey: string;
    startMs: number;
    endMs: number;
    outcome: 'failed' | 'unresolved';
    reasonCode: Exclude<IOSNativePostProcessingReasonCode, 'NONE'>;
  }>;
  coverage: {
    windowCount: number;
    completedWindows: number;
    failedWindows: number;
    unresolvedWindows: number;
    coverageComplete: boolean;
  };
  resultPayloadSha256: string;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RESULT_ID = /^npr_[a-f0-9]{32}$/;
const LANGUAGE = /^[A-Za-z][A-Za-z0-9-]{1,15}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REASON_CODES = new Set<IOSNativePostProcessingReasonCode>([
  'NONE', 'MODEL_UNAVAILABLE', 'RUNTIME_INTERRUPTED', 'AUDIO_UNREADABLE',
  'RETRY_BUDGET_EXHAUSTED', 'OWNER_RELEASED',
]);

function nativeResultMismatch(): never {
  throw new Error('Native post-processing result contract mismatch.');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return nativeResultMismatch();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    nativeResultMismatch();
  }
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return nativeResultMismatch();
  }
  return value as number;
}

function finiteText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    return nativeResultMismatch();
  }
  return value;
}

function matches(value: unknown, pattern: RegExp): string {
  const text = finiteText(value, 1, 256);
  if (!pattern.test(text)) return nativeResultMismatch();
  return text;
}

export function decodeIOSNativePostProcessingResult(
  value: unknown,
  expected: { ownerUserId: string; meetingId: string; runId: string; generation: number },
): IOSNativePostProcessingResult {
  const root = record(value);
  exactKeys(root, [
    'schemaVersion', 'identity', 'disposition', 'audio', 'windowConfig', 'windows',
    'unresolvedIntervals', 'coverage', 'resultPayloadSha256',
  ]);
  if (root.schemaVersion !== 'maina.native-post-processing-result.v1') nativeResultMismatch();

  const identity = record(root.identity);
  exactKeys(identity, [
    'ownerUserId', 'meetingId', 'runId', 'generation', 'resultId', 'audioFingerprintSha256',
    'contractVersion', 'modelId', 'modelVersion', 'runtimeVersion', 'createdAt',
  ]);
  const ownerUserId = matches(identity.ownerUserId, IDENTIFIER);
  const meetingId = matches(identity.meetingId, IDENTIFIER);
  const runId = matches(identity.runId, IDENTIFIER);
  const generation = integer(identity.generation, 1);
  if (ownerUserId !== expected.ownerUserId || meetingId !== expected.meetingId
    || runId !== expected.runId || generation !== expected.generation) nativeResultMismatch();
  matches(identity.resultId, RESULT_ID);
  matches(identity.audioFingerprintSha256, SHA256);
  if (identity.contractVersion !== '1.0') nativeResultMismatch();
  matches(identity.modelId, IDENTIFIER);
  matches(identity.modelVersion, IDENTIFIER);
  matches(identity.runtimeVersion, IDENTIFIER);
  const createdAt = matches(identity.createdAt, ISO_DATE);
  if (!Number.isFinite(Date.parse(createdAt))) nativeResultMismatch();

  if (root.disposition !== 'complete' && root.disposition !== 'partial') nativeResultMismatch();
  const audio = record(root.audio);
  exactKeys(audio, ['durationMs', 'segmentCount']);
  const durationMs = integer(audio.durationMs, 1, 86_400_000);
  integer(audio.segmentCount, 1, 10_000);

  const windowConfig = record(root.windowConfig);
  exactKeys(windowConfig, ['targetWindowMs', 'analysisOverlapMs', 'maxAttempts']);
  const targetWindowMs = integer(windowConfig.targetWindowMs, 1_000, 600_000);
  const analysisOverlapMs = integer(windowConfig.analysisOverlapMs, 0, 30_000);
  const maxAttempts = integer(windowConfig.maxAttempts, 1, 10);
  if (analysisOverlapMs >= targetWindowMs) nativeResultMismatch();

  if (!Array.isArray(root.windows) || root.windows.length < 1 || root.windows.length > 10_000) {
    nativeResultMismatch();
  }
  const windowKeys = new Set<string>();
  const blockKeys = new Set<string>();
  let nextCoverageStart = 0;
  let nextBlockSequence = 0;
  let completedWindows = 0;
  let failedWindows = 0;
  let unresolvedWindows = 0;
  const terminalIntervals: Array<{
    windowKey: string; startMs: number; endMs: number;
    outcome: 'failed' | 'unresolved'; reasonCode: string;
  }> = [];

  root.windows.forEach((candidate, index) => {
    const window = record(candidate);
    exactKeys(window, [
      'windowKey', 'index', 'coverageStartMs', 'coverageEndMs', 'analysisStartMs',
      'analysisEndMs', 'status', 'blocks', 'retry', 'vad',
    ]);
    const windowKey = matches(window.windowKey, IDENTIFIER);
    if (windowKeys.has(windowKey) || integer(window.index, 0) !== index) nativeResultMismatch();
    windowKeys.add(windowKey);
    const coverageStartMs = integer(window.coverageStartMs, 0, durationMs - 1);
    const coverageEndMs = integer(window.coverageEndMs, 1, durationMs);
    const analysisStartMs = integer(window.analysisStartMs, 0, durationMs - 1);
    const analysisEndMs = integer(window.analysisEndMs, 1, durationMs);
    if (coverageStartMs !== nextCoverageStart || coverageEndMs <= coverageStartMs
      || analysisStartMs > coverageStartMs || analysisEndMs < coverageEndMs
      || analysisEndMs <= analysisStartMs) nativeResultMismatch();
    nextCoverageStart = coverageEndMs;
    if (window.status !== 'completed' && window.status !== 'failed' && window.status !== 'unresolved') {
      nativeResultMismatch();
    }

    if (!Array.isArray(window.blocks) || window.blocks.length > 1_000) nativeResultMismatch();
    window.blocks.forEach((candidateBlock) => {
      const block = record(candidateBlock);
      exactKeys(block, ['blockKey', 'sequence', 'startedAtMs', 'endedAtMs', 'text', 'language']);
      const blockKey = matches(block.blockKey, IDENTIFIER);
      if (blockKeys.has(blockKey) || integer(block.sequence, 0) !== nextBlockSequence) nativeResultMismatch();
      blockKeys.add(blockKey);
      nextBlockSequence += 1;
      const startedAtMs = integer(block.startedAtMs, coverageStartMs, coverageEndMs - 1);
      const endedAtMs = integer(block.endedAtMs, 1, coverageEndMs);
      if (endedAtMs <= startedAtMs) nativeResultMismatch();
      finiteText(block.text, 1, 8_192);
      matches(block.language, LANGUAGE);
    });

    const retry = record(window.retry);
    exactKeys(retry, ['attemptCount', 'maxAttempts', 'lastReasonCode']);
    integer(retry.attemptCount, 1, maxAttempts);
    if (integer(retry.maxAttempts, 1, 10) !== maxAttempts
      || typeof retry.lastReasonCode !== 'string'
      || !REASON_CODES.has(retry.lastReasonCode as IOSNativePostProcessingReasonCode)) {
      nativeResultMismatch();
    }
    const vad = record(window.vad);
    exactKeys(vad, ['status', 'evidenceSha256']);
    if (vad.status !== 'speech' && vad.status !== 'silence' && vad.status !== 'unavailable') {
      nativeResultMismatch();
    }
    matches(vad.evidenceSha256, SHA256);

    if (window.status === 'completed') {
      completedWindows += 1;
      if (retry.lastReasonCode !== 'NONE') nativeResultMismatch();
    } else {
      if (window.blocks.length !== 0 || retry.lastReasonCode === 'NONE') nativeResultMismatch();
      if (window.status === 'failed') failedWindows += 1;
      else unresolvedWindows += 1;
      terminalIntervals.push({
        windowKey, startMs: coverageStartMs, endMs: coverageEndMs,
        outcome: window.status, reasonCode: retry.lastReasonCode,
      });
    }
  });
  if (nextCoverageStart !== durationMs) nativeResultMismatch();

  if (!Array.isArray(root.unresolvedIntervals) || root.unresolvedIntervals.length > 10_000
    || root.unresolvedIntervals.length !== terminalIntervals.length) nativeResultMismatch();
  root.unresolvedIntervals.forEach((candidate, index) => {
    const interval = record(candidate);
    exactKeys(interval, ['windowKey', 'startMs', 'endMs', 'outcome', 'reasonCode']);
    const expectedInterval = terminalIntervals[index];
    if (interval.windowKey !== expectedInterval.windowKey
      || interval.startMs !== expectedInterval.startMs
      || interval.endMs !== expectedInterval.endMs
      || interval.outcome !== expectedInterval.outcome
      || interval.reasonCode !== expectedInterval.reasonCode) nativeResultMismatch();
  });

  const coverage = record(root.coverage);
  exactKeys(coverage, [
    'windowCount', 'completedWindows', 'failedWindows', 'unresolvedWindows', 'coverageComplete',
  ]);
  if (coverage.windowCount !== root.windows.length
    || coverage.completedWindows !== completedWindows
    || coverage.failedWindows !== failedWindows
    || coverage.unresolvedWindows !== unresolvedWindows) nativeResultMismatch();
  const complete = terminalIntervals.length === 0 && completedWindows === root.windows.length;
  if (coverage.coverageComplete !== complete
    || (root.disposition === 'complete') !== complete) nativeResultMismatch();
  matches(root.resultPayloadSha256, SHA256);

  return root as IOSNativePostProcessingResult;
}

export function deriveNativeTranscriptOutcome(input: {
  hasText: boolean;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  lastError?: string | null;
}): NativeTranscriptOutcome {
  const windowCount = Math.max(0, input.windowCount);
  const completedWindows = Math.max(0, input.completedWindows);
  const failedWindows = Math.max(0, input.failedWindows);
  const coverageComplete = windowCount > 0
    && failedWindows === 0
    && completedWindows === windowCount;

  if (coverageComplete && input.hasText) {
    return { status: 'transcribed', coverageComplete: true, error: null };
  }
  if (input.hasText) {
    return {
      status: 'transcript_partial',
      coverageComplete: false,
      error: input.lastError?.trim() || 'Some audio could not be transcribed. The audio was kept for recovery.',
    };
  }
  return {
    status: 'recorded',
    coverageComplete,
    error: input.lastError?.trim() || 'Local transcription produced no text. The audio was kept for recovery.',
  };
}

export function nativeProgress(input: {
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
}): { completed: number; total: number; ratio: number | null } {
  const total = Math.max(0, input.windowCount);
  const completed = Math.min(
    total,
    Math.max(0, input.completedWindows) + Math.max(0, input.failedWindows),
  );
  return { completed, total, ratio: total > 0 ? completed / total : null };
}

/**
 * Native retries deliberately keep the same durable run ID so an interruption
 * cannot create a second transcript lineage. That ID alone therefore cannot
 * decide idempotency: import again only when that run has made measurable
 * progress (for example 12/13 partial windows becoming 13/13 complete).
 */
export function shouldImportNativePostProcessingResult(input: {
  persistedRunId?: string | null;
  persistedWindowCount: number;
  persistedCompletedWindows: number;
  persistedFailedWindows: number;
  incomingRunId: string;
  incomingWindowCount: number;
  incomingCompletedWindows: number;
  incomingFailedWindows: number;
}): boolean {
  if (input.persistedRunId !== input.incomingRunId) return true;
  return input.persistedWindowCount !== input.incomingWindowCount
    || input.persistedCompletedWindows !== input.incomingCompletedWindows
    || input.persistedFailedWindows !== input.incomingFailedWindows;
}

/**
 * An outbox acknowledgement can fail after the Expo database has been
 * imported. A later lifecycle write may also leave that database row in an
 * in-progress state. The durable native result is authoritative, but never
 * move a meeting backwards once notes are being generated or are complete.
 */
export function shouldRepairNativeTranscriptStatus(input: {
  persistedStatus: string;
  incomingStatus: NativeTranscriptOutcome['status'];
}): boolean {
  if (input.persistedStatus === input.incomingStatus) return false;
  return [
    'recording',
    'interrupted',
    'recorded',
    'transcribing',
    'transcript_partial',
    'audio_expired_incomplete',
  ].includes(input.persistedStatus);
}
