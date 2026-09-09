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
  windows: {
    windowKey: string;
    index: number;
    coverageStartMs: number;
    coverageEndMs: number;
    analysisStartMs: number;
    analysisEndMs: number;
    status: 'completed' | 'failed' | 'unresolved';
    blocks: {
      blockKey: string;
      sequence: number;
      startedAtMs: number;
      endedAtMs: number;
      text: string;
      language: string;
    }[];
    retry: {
      attemptCount: number;
      maxAttempts: number;
      lastReasonCode: IOSNativePostProcessingReasonCode;
    };
    vad: { status: 'speech' | 'silence' | 'unavailable'; evidenceSha256: string };
  }[];
  unresolvedIntervals: {
    windowKey: string;
    startMs: number;
    endMs: number;
    outcome: 'failed' | 'unresolved';
    reasonCode: Exclude<IOSNativePostProcessingReasonCode, 'NONE'>;
  }[];
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

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Small dependency-free SHA-256 used only for stable local custody identities. */
export function sha256Utf8(value: string): string {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

export type IOSNativePostProcessingExecutionIdentity = {
  ownerUserId: string;
  meetingId: string;
  runId: string;
  generation: 1;
  runtimeOwnerToken: string;
};

export const IOS_NATIVE_POST_PROCESSING_WINDOW_CONFIG = Object.freeze({
  targetWindowMs: 15_000,
  analysisOverlapMs: 2_000,
  maxAttempts: 2,
});

export function deriveIOSNativePostProcessingExecutionIdentity(
  ownerUserId: string,
  meetingId: string,
): IOSNativePostProcessingExecutionIdentity {
  if (!IDENTIFIER.test(ownerUserId) || !IDENTIFIER.test(meetingId)) {
    throw new Error('Native post-processing execution identity is invalid.');
  }
  const digest = sha256Utf8(`maina.ios-native-post-processing.v1\n${ownerUserId}\n${meetingId}`);
  return {
    ownerUserId,
    meetingId,
    runId: `iosnpr_${digest.slice(0, 32)}`,
    generation: 1,
    runtimeOwnerToken: `iosruntime_${digest.slice(32)}`,
  };
}

export function buildIOSNativePostProcessingStartRequest(input: {
  ownerUserId: string;
  meetingId: string;
  audioFingerprintSha256: string;
}) {
  if (!SHA256.test(input.audioFingerprintSha256)) {
    throw new Error('Native post-processing audio fingerprint is invalid.');
  }
  const identity = deriveIOSNativePostProcessingExecutionIdentity(
    input.ownerUserId,
    input.meetingId,
  );
  return {
    ownerUserId: identity.ownerUserId,
    meetingId: identity.meetingId,
    runId: identity.runId,
    generation: identity.generation,
    audioFingerprintSha256: input.audioFingerprintSha256,
    windowConfig: { ...IOS_NATIVE_POST_PROCESSING_WINDOW_CONFIG },
    runtimeOwnerToken: identity.runtimeOwnerToken,
  };
}

export function buildIOSNativePostProcessingImportFence(
  result: IOSNativePostProcessingResult,
  durableImport: { importedAt: string; transactionCommitSha256: string },
) {
  if (!ISO_DATE.test(durableImport.importedAt)
    || !Number.isFinite(Date.parse(durableImport.importedAt))
    || !SHA256.test(durableImport.transactionCommitSha256)) {
    throw new Error('Native post-processing durable import fence is invalid.');
  }
  return {
    schemaVersion: 'maina.native-post-processing-import-fence.v1' as const,
    state: 'DURABLE' as const,
    ownerUserId: result.identity.ownerUserId,
    meetingId: result.identity.meetingId,
    runId: result.identity.runId,
    generation: result.identity.generation,
    resultId: result.identity.resultId,
    resultPayloadSha256: result.resultPayloadSha256,
    importedAt: durableImport.importedAt,
    transactionCommitSha256: durableImport.transactionCommitSha256,
  };
}

export function deriveIOSNativeImportCommitSha256(input: {
  ownerUserId: string;
  meetingId: string;
  runId: string;
  generation: number;
  resultId: string;
  resultPayloadSha256: string;
  importedAtMs: number;
  durationMs: number;
  audioDurationMs: number;
  segmentCount: number;
  windowCount: number;
  completedWindows: number;
  failedWindows: number;
  blockCount: number;
}): string {
  const values = [
    'maina.native-post-processing-import-commit.v1',
    input.ownerUserId, input.meetingId, input.runId, String(input.generation), input.resultId,
    input.resultPayloadSha256, String(input.importedAtMs), String(input.durationMs),
    String(input.audioDurationMs), String(input.segmentCount), String(input.windowCount), String(input.completedWindows),
    String(input.failedWindows), String(input.blockCount),
  ];
  return sha256Utf8(values.join('\n'));
}

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
  const terminalIntervals: {
    windowKey: string; startMs: number; endMs: number;
    outcome: 'failed' | 'unresolved'; reasonCode: string;
  }[] = [];

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
