export const MAINA_MODEL_PACK_ID = 'qwen3-asr-0.6b-int8' as const;
export const MAINA_MODEL_ENGINE_ID = 'qwen3-0.6b-int8' as const;
export const MAINA_MODEL_PACK_FORMAT_VERSION = '1' as const;

export type NativeModelPackPlatform = 'android' | 'ios';
export type NativeModelPackState =
  | 'unavailable'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'smoke_testing'
  | 'ready'
  | 'failed_download'
  | 'failed_verification'
  | 'failed_smoke'
  | 'rollback_pending';

export type NativeModelPackReasonCode =
  | 'NONE'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_HASH_MISMATCH'
  | 'MANIFEST_PATH_INVALID'
  | 'MANIFEST_FILE_SET_MISMATCH'
  | 'PLATFORM_COMPATIBILITY_MISMATCH'
  | 'FILE_EVIDENCE_MISMATCH'
  | 'RESUME_IDENTITY_MISMATCH'
  | 'RESUME_PREFIX_INVALID'
  | 'STORAGE_PREFLIGHT_FAILED'
  | 'LIFECYCLE_TRANSITION_INVALID'
  | 'SMOKE_RECEIPT_MISMATCH'
  | 'PROMOTION_PRECONDITION_FAILED'
  | 'RESULT_BINDING_MISMATCH'
  | 'CLEANUP_BOUNDARY_MISMATCH';

export interface NativeModelPackManifestFile {
  path: string;
  byteCount: number;
  sha256: string;
  chunkSizeBytes: number;
  chunkSha256: string[];
}

export interface NativeModelPackManifestPlatform {
  osFamily: NativeModelPackPlatform;
  minOsVersion: string;
  architectures: string[];
  runtimeVersion: string;
  runtimeSha256: string;
  smokeExpectedTextSha256: string;
}

export interface NativeModelPackManifest {
  schemaVersion: 'maina.model-pack-manifest.v1';
  packId: typeof MAINA_MODEL_PACK_ID;
  packVersion: string;
  engineId: typeof MAINA_MODEL_ENGINE_ID;
  formatVersion: typeof MAINA_MODEL_PACK_FORMAT_VERSION;
  files: NativeModelPackManifestFile[];
  platforms: NativeModelPackManifestPlatform[];
  smokeInputSha256: string;
  manifestSha256: string;
}

export interface NativeModelPackObservedFile {
  path: string;
  kind: 'regular';
  byteCount: number;
  sha256: string;
  chunkSha256: string[];
}

export interface NativeModelPackPublicStatus {
  packId: typeof MAINA_MODEL_PACK_ID;
  packVersion: string | null;
  state: NativeModelPackState;
  bytesComplete: number;
  bytesTotal: number;
  reasonCode: NativeModelPackReasonCode;
  platformCompatible: boolean;
}

export interface NativeModelPackSmokeReceipt {
  manifestSha256: string;
  platform: NativeModelPackPlatform;
  runtimeVersion: string;
  runtimeSha256: string;
  inputSha256: string;
  normalizedTextSha256: string;
  startedAt: number;
  completedAt: number;
  status: 'passed';
}

export interface NativeModelPackLifecycleIdentity {
  packId: typeof MAINA_MODEL_PACK_ID;
  packVersion: string;
  manifestSha256: string;
  platform: NativeModelPackPlatform;
  activationGeneration: number;
}

export interface NativeModelPackResultMapping extends NativeModelPackLifecycleIdentity {
  modelId: typeof MAINA_MODEL_ENGINE_ID;
  modelVersion: string;
  runtimeVersion: string;
  lifecycleRecordSha256: string;
  packRetained: boolean;
  referencedResultIds: string[];
}

export interface NativeModelPackResultEvidence {
  resultId: string;
  resultPayloadSha256: string;
}

export interface NativeModelPackValidatedResultBinding {
  p2Result: {
    identity: {
      resultId: string;
      modelId: typeof MAINA_MODEL_ENGINE_ID;
      modelVersion: string;
      runtimeVersion: string;
    };
    resultPayloadSha256: string;
  };
  lifecycleMappings: NativeModelPackResultMapping[];
}

export interface NativeModelPackScopedCounts {
  targetManifestSha256: string;
  targetPlatform: NativeModelPackPlatform;
  targetActivationGeneration: number;
  pinnedReaderCount: number;
  resultReferenceCount: number;
}

export interface NativeModelPackResumeRecord {
  manifestSha256: string;
  platform: NativeModelPackPlatform;
  path: string;
  byteCount: number;
  verifiedChunkSha256: string[];
}

export type NativeModelPackValidation<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; code: NativeModelPackReasonCode };

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DOTTED_VERSION = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const REQUIRED_FILES = new Map<string, number>([
  ['conv_frontend.onnx', 44_148_281],
  ['encoder.int8.onnx', 182_491_662],
  ['decoder.int8.onnx', 755_914_231],
  ['tokenizer/vocab.json', 2_776_833],
  ['tokenizer/merges.txt', 1_671_853],
  ['tokenizer/tokenizer_config.json', 12_487],
]);
const MANIFEST_KEYS = ['schemaVersion', 'packId', 'packVersion', 'engineId', 'formatVersion', 'files', 'platforms', 'smokeInputSha256', 'manifestSha256'];
const FILE_KEYS = ['path', 'byteCount', 'sha256', 'chunkSizeBytes', 'chunkSha256'];
const PLATFORM_KEYS = ['osFamily', 'minOsVersion', 'architectures', 'runtimeVersion', 'runtimeSha256', 'smokeExpectedTextSha256'];
const SMOKE_KEYS = ['manifestSha256', 'platform', 'runtimeVersion', 'runtimeSha256', 'inputSha256', 'normalizedTextSha256', 'startedAt', 'completedAt', 'status'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length && actual.every((key, index) => key === required[index]);
}

function safePositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeNonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function decodeVersion(value: unknown): string[] | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !DOTTED_VERSION.test(value)) {
    return null;
  }
  return value.split('.').map((part) => part.replace(/^0+(?=[0-9])/, ''));
}

function compareVersion(actual: unknown, minimum: unknown): boolean {
  const left = decodeVersion(actual);
  const right = decodeVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? '0';
    const b = right[index] ?? '0';
    if (a.length !== b.length) return a.length > b.length;
    if (a !== b) return a > b;
  }
  return true;
}

/** RFC 8785 for the manifest's deliberately restricted JSON domain. */
export function canonicalModelPackJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Model-pack canonical JSON accepts safe integers only.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalModelPackJson).join(',')}]`;
  if (!record(value)) throw new Error('Model-pack canonical JSON contains an unsupported value.');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalModelPackJson(value[key])}`).join(',')}}`;
}

export function canonicalModelPackManifestJson(manifest: NativeModelPackManifest): string {
  const { manifestSha256: _discarded, ...unsigned } = manifest;
  return canonicalModelPackJson(unsigned);
}

export function decodeNativeModelPackManifest(value: unknown): NativeModelPackValidation<NativeModelPackManifest> {
  if (!record(value) || !exactKeys(value, MANIFEST_KEYS)) return { ok: false, code: 'MANIFEST_INVALID' };
  if (value.schemaVersion !== 'maina.model-pack-manifest.v1'
    || value.packId !== MAINA_MODEL_PACK_ID
    || value.engineId !== MAINA_MODEL_ENGINE_ID
    || value.formatVersion !== MAINA_MODEL_PACK_FORMAT_VERSION
    || typeof value.packVersion !== 'string' || !ID.test(value.packVersion)
    || typeof value.smokeInputSha256 !== 'string' || !SHA256.test(value.smokeInputSha256)
    || typeof value.manifestSha256 !== 'string' || !SHA256.test(value.manifestSha256)
    || !Array.isArray(value.files) || !Array.isArray(value.platforms)) {
    return { ok: false, code: 'MANIFEST_INVALID' };
  }

  const files: NativeModelPackManifestFile[] = [];
  const paths = new Set<string>();
  const folded = new Set<string>();
  for (const candidate of value.files) {
    if (!record(candidate) || !exactKeys(candidate, FILE_KEYS)
      || typeof candidate.path !== 'string'
      || !safePositive(candidate.byteCount)
      || typeof candidate.sha256 !== 'string'
      || !safePositive(candidate.chunkSizeBytes)
      || !Array.isArray(candidate.chunkSha256)
      || !candidate.chunkSha256.every((digest) => typeof digest === 'string')) {
      return { ok: false, code: 'MANIFEST_INVALID' };
    }
    if (!safePath(candidate.path)
      || !SHA256.test(candidate.sha256)
      || candidate.chunkSha256.length !== Math.ceil(candidate.byteCount / candidate.chunkSizeBytes)
      || !candidate.chunkSha256.every((digest) => SHA256.test(digest))) {
      return { ok: false, code: 'MANIFEST_PATH_INVALID' };
    }
    const lower = candidate.path.toLocaleLowerCase('en-US');
    if (paths.has(candidate.path) || folded.has(lower)) return { ok: false, code: 'MANIFEST_PATH_INVALID' };
    paths.add(candidate.path);
    folded.add(lower);
    files.push(candidate as unknown as NativeModelPackManifestFile);
  }
  if (files.length !== REQUIRED_FILES.size
    || [...REQUIRED_FILES].some(([path, bytes]) => !paths.has(path) || files.find((file) => file.path === path)?.byteCount !== bytes)) {
    return { ok: false, code: 'MANIFEST_FILE_SET_MISMATCH' };
  }

  const platforms: NativeModelPackManifestPlatform[] = [];
  const platformNames = new Set<string>();
  for (const candidate of value.platforms) {
    if (!record(candidate) || !exactKeys(candidate, PLATFORM_KEYS)
      || typeof candidate.osFamily !== 'string' || !['android', 'ios'].includes(candidate.osFamily)
      || decodeVersion(candidate.minOsVersion) === null
      || !Array.isArray(candidate.architectures) || candidate.architectures.length === 0
      || !candidate.architectures.every((entry) => typeof entry === 'string' && ID.test(entry))
      || new Set(candidate.architectures).size !== candidate.architectures.length
      || typeof candidate.runtimeVersion !== 'string' || !ID.test(candidate.runtimeVersion)
      || typeof candidate.runtimeSha256 !== 'string' || !SHA256.test(candidate.runtimeSha256)
      || typeof candidate.smokeExpectedTextSha256 !== 'string' || !SHA256.test(candidate.smokeExpectedTextSha256)) {
      return { ok: false, code: 'MANIFEST_INVALID' };
    }
    platformNames.add(candidate.osFamily);
    platforms.push(candidate as unknown as NativeModelPackManifestPlatform);
  }
  if (platforms.length !== 2 || !platformNames.has('android') || !platformNames.has('ios')) {
    return { ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' };
  }
  return { ok: true, value: { ...value, files, platforms } as unknown as NativeModelPackManifest };
}

export function validateNativeModelPack(
  value: unknown,
  options: {
    computedManifestSha256: string;
    observedFiles: NativeModelPackObservedFile[];
    platform: NativeModelPackPlatform;
    osVersion: string;
    architecture: string;
    runtimeVersion: string;
    runtimeSha256: string;
  },
): NativeModelPackValidation<NativeModelPackManifest> {
  const decoded = decodeNativeModelPackManifest(value);
  if (!decoded.ok) return decoded;
  const manifest = decoded.value;
  if (!SHA256.test(options.computedManifestSha256) || manifest.manifestSha256 !== options.computedManifestSha256) {
    return { ok: false, code: 'MANIFEST_HASH_MISMATCH' };
  }
  const platform = manifest.platforms.find((entry) => entry.osFamily === options.platform);
  if (!platform || !compareVersion(options.osVersion, platform.minOsVersion)
    || !platform.architectures.includes(options.architecture)
    || platform.runtimeVersion !== options.runtimeVersion
    || platform.runtimeSha256 !== options.runtimeSha256) {
    return { ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' };
  }
  if (options.observedFiles.length !== manifest.files.length) return { ok: false, code: 'FILE_EVIDENCE_MISMATCH' };
  const observed = new Map<string, NativeModelPackObservedFile>();
  for (const file of options.observedFiles) {
    if (!record(file) || !exactKeys(file, ['path', 'kind', 'byteCount', 'sha256', 'chunkSha256'])
      || file.kind !== 'regular' || typeof file.path !== 'string' || !safePath(file.path)
      || !safePositive(file.byteCount) || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)
      || !Array.isArray(file.chunkSha256)
      || !file.chunkSha256.every((digest) => typeof digest === 'string' && SHA256.test(digest))
      || observed.has(file.path)) {
      return { ok: false, code: 'FILE_EVIDENCE_MISMATCH' };
    }
    observed.set(file.path, file as NativeModelPackObservedFile);
  }
  for (const expected of manifest.files) {
    const actual = observed.get(expected.path);
    if (!actual || actual.byteCount !== expected.byteCount || actual.sha256 !== expected.sha256
      || actual.chunkSha256.length !== expected.chunkSha256.length
      || actual.chunkSha256.some((digest, index) => digest !== expected.chunkSha256[index])) {
      return { ok: false, code: 'FILE_EVIDENCE_MISMATCH' };
    }
  }
  return { ok: true, value: manifest };
}

const TRANSITIONS = new Set([
  'unavailable>downloading:manifest_valid_and_space_preflight_passed',
  'downloading>downloading:exact_chunk_progress_committed',
  'downloading>verifying:all_declared_bytes_present',
  'downloading>failed_download:bounded_download_failure_recorded',
  'failed_download>downloading:same_manifest_and_verified_prefix',
  'verifying>staged:exact_file_set_bytes_and_hashes_verified',
  'verifying>failed_verification:verification_failure_recorded',
  'failed_verification>downloading:same_manifest_invalid_bytes_removed',
  'staged>smoke_testing:compatible_platform_runtime_selected',
  'smoke_testing>ready:smoke_receipt_and_atomic_pointer_durable',
  'smoke_testing>failed_smoke:smoke_failure_recorded',
  'ready>rollback_pending:pre_first_result_open_or_identity_failure',
  'rollback_pending>failed_smoke:previous_ready_pointer_restored',
  'ready>downloading:different_valid_manifest_staged_without_active_mutation',
]);

export function validateNativeModelPackTransition(
  from: NativeModelPackState,
  to: NativeModelPackState,
  guard: string,
): NativeModelPackValidation {
  return TRANSITIONS.has(`${from}>${to}:${guard}`)
    ? { ok: true, value: undefined }
    : { ok: false, code: 'LIFECYCLE_TRANSITION_INVALID' };
}

export function validateNativeModelPackResume(
  stored: NativeModelPackResumeRecord,
  requested: NativeModelPackResumeRecord,
  manifest: NativeModelPackManifest,
): NativeModelPackValidation<number> {
  if (stored.manifestSha256 !== manifest.manifestSha256
    || requested.manifestSha256 !== manifest.manifestSha256
    || stored.manifestSha256 !== requested.manifestSha256
    || stored.platform !== requested.platform || stored.path !== requested.path
    || stored.byteCount !== requested.byteCount) {
    return { ok: false, code: 'RESUME_IDENTITY_MISMATCH' };
  }
  const file = manifest.files.find((entry) => entry.path === stored.path);
  if (!file || file.byteCount !== stored.byteCount
    || stored.verifiedChunkSha256.length > file.chunkSha256.length
    || requested.verifiedChunkSha256.length !== stored.verifiedChunkSha256.length
    || stored.verifiedChunkSha256.some((digest, index) => digest !== file.chunkSha256[index]
      || requested.verifiedChunkSha256[index] !== digest)) {
    return { ok: false, code: 'RESUME_PREFIX_INVALID' };
  }
  return { ok: true, value: stored.verifiedChunkSha256.length };
}

export function validateNativeModelPackStorage(input: {
  newPackBytes: number;
  partialOverheadBytes: number;
  retainedRollbackBytes: number;
  safetyMarginBytes: number;
  availableBytes: number;
}): NativeModelPackValidation<number> {
  const values = Object.values(input);
  if (!values.every(safeNonnegative)) return { ok: false, code: 'STORAGE_PREFLIGHT_FAILED' };
  const requiredBytes = input.newPackBytes + input.partialOverheadBytes + input.retainedRollbackBytes + input.safetyMarginBytes;
  if (!Number.isSafeInteger(requiredBytes) || input.availableBytes < requiredBytes) {
    return { ok: false, code: 'STORAGE_PREFLIGHT_FAILED' };
  }
  return { ok: true, value: requiredBytes };
}

export function validateNativeModelPackSmokeReceipt(
  value: unknown,
  manifest: NativeModelPackManifest,
  platformName: NativeModelPackPlatform,
): NativeModelPackValidation<NativeModelPackSmokeReceipt> {
  if (!record(value) || !exactKeys(value, SMOKE_KEYS)
    || value.status !== 'passed' || value.platform !== platformName
    || typeof value.manifestSha256 !== 'string' || value.manifestSha256 !== manifest.manifestSha256
    || typeof value.runtimeVersion !== 'string' || typeof value.runtimeSha256 !== 'string'
    || typeof value.inputSha256 !== 'string' || typeof value.normalizedTextSha256 !== 'string'
    || !safeNonnegative(value.startedAt) || !safePositive(value.completedAt) || value.completedAt < value.startedAt) {
    return { ok: false, code: 'SMOKE_RECEIPT_MISMATCH' };
  }
  const platform = manifest.platforms.find((entry) => entry.osFamily === platformName);
  if (!platform || value.runtimeVersion !== platform.runtimeVersion || value.runtimeSha256 !== platform.runtimeSha256
    || value.inputSha256 !== manifest.smokeInputSha256
    || value.normalizedTextSha256 !== platform.smokeExpectedTextSha256) {
    return { ok: false, code: 'SMOKE_RECEIPT_MISMATCH' };
  }
  return { ok: true, value: value as unknown as NativeModelPackSmokeReceipt };
}

export function validateNativeModelPackPromotion(input: {
  manifestVerified: boolean;
  platformCompatible: boolean;
  smokePassed: boolean;
  previousReadyRetained: boolean;
  conflictingWriter: boolean;
  pointerAction: 'atomic_replace' | string;
  stagedFsync: boolean;
  pointerFsync: boolean;
  parentFsync: boolean;
  readyPublishedAfterDurability: boolean;
  deletedPreviousBeforeReady: boolean;
}): NativeModelPackValidation {
  return input.manifestVerified && input.platformCompatible && input.smokePassed
    && input.previousReadyRetained && !input.conflictingWriter
    && input.pointerAction === 'atomic_replace'
    && input.stagedFsync && input.pointerFsync && input.parentFsync
    && input.readyPublishedAfterDurability && !input.deletedPreviousBeforeReady
    ? { ok: true, value: undefined }
    : { ok: false, code: 'PROMOTION_PRECONDITION_FAILED' };
}

export function validateNativeModelPackResultMapping(
  incoming: NativeModelPackResultMapping,
  existing: readonly NativeModelPackResultMapping[],
): NativeModelPackValidation<NativeModelPackResultMapping> {
  if (!validResultMapping(incoming)) {
    return { ok: false, code: 'RESULT_BINDING_MISMATCH' };
  }
  if (!existing.every(validResultMapping)) return { ok: false, code: 'RESULT_BINDING_MISMATCH' };
  const sameTuple = existing.filter((entry) => entry.modelId === incoming.modelId
    && entry.modelVersion === incoming.modelVersion && entry.runtimeVersion === incoming.runtimeVersion);
  if (sameTuple.length > 1 || sameTuple.some((entry) => entry.manifestSha256 !== incoming.manifestSha256
    || entry.platform !== incoming.platform
    || entry.activationGeneration !== incoming.activationGeneration
    || entry.lifecycleRecordSha256 !== incoming.lifecycleRecordSha256)) {
    return { ok: false, code: 'RESULT_BINDING_MISMATCH' };
  }
  return { ok: true, value: incoming };
}

function validResultMapping(value: unknown): value is NativeModelPackResultMapping {
  if (!record(value) || !exactKeys(value, [
    'packId', 'packVersion', 'manifestSha256', 'platform', 'activationGeneration',
    'modelId', 'modelVersion', 'runtimeVersion', 'lifecycleRecordSha256', 'packRetained', 'referencedResultIds',
  ])) return false;
  return value.packId === MAINA_MODEL_PACK_ID && value.modelId === MAINA_MODEL_ENGINE_ID
    && typeof value.packVersion === 'string' && ID.test(value.packVersion)
    && typeof value.modelVersion === 'string' && ID.test(value.modelVersion)
    && typeof value.runtimeVersion === 'string' && ID.test(value.runtimeVersion)
    && typeof value.manifestSha256 === 'string' && SHA256.test(value.manifestSha256)
    && typeof value.lifecycleRecordSha256 === 'string' && SHA256.test(value.lifecycleRecordSha256)
    && ['android', 'ios'].includes(String(value.platform))
    && safePositive(value.activationGeneration) && value.packRetained === true
    && Array.isArray(value.referencedResultIds) && value.referencedResultIds.length > 0
    && new Set(value.referencedResultIds).size === value.referencedResultIds.length
    && value.referencedResultIds.every((id) => typeof id === 'string' && ID.test(id));
}

export function nativeModelPackCleanupEligible(input: {
  target: NativeModelPackLifecycleIdentity & { lifecycleRecordSha256: string };
  successor: NativeModelPackResultMapping;
  firstExactSuccessorResult: NativeModelPackResultEvidence | null;
  validatedResultBinding: NativeModelPackValidatedResultBinding;
  scopedCounts: NativeModelPackScopedCounts;
  active: boolean;
  rollbackRetained: boolean;
  inProgress: boolean;
}): NativeModelPackValidation {
  const result = input.firstExactSuccessorResult;
  const counts = input.scopedCounts;
  const binding = input.validatedResultBinding;
  const validatedResult = record(binding) && exactKeys(binding, ['p2Result', 'lifecycleMappings'])
    && record(binding.p2Result) && exactKeys(binding.p2Result, ['identity', 'resultPayloadSha256'])
    && record(binding.p2Result.identity) && exactKeys(binding.p2Result.identity, ['resultId', 'modelId', 'modelVersion', 'runtimeVersion'])
    && typeof binding.p2Result.identity.resultId === 'string' && ID.test(binding.p2Result.identity.resultId)
    && binding.p2Result.identity.modelId === MAINA_MODEL_ENGINE_ID
    && typeof binding.p2Result.identity.modelVersion === 'string' && ID.test(binding.p2Result.identity.modelVersion)
    && typeof binding.p2Result.identity.runtimeVersion === 'string' && ID.test(binding.p2Result.identity.runtimeVersion)
    && typeof binding.p2Result.resultPayloadSha256 === 'string' && SHA256.test(binding.p2Result.resultPayloadSha256)
    && Array.isArray(binding.lifecycleMappings)
    && binding.lifecycleMappings.length > 0
    && binding.lifecycleMappings.every(validResultMapping);
  const exactMapping = validatedResult
    ? binding.lifecycleMappings.filter((entry) => entry.modelId === binding.p2Result.identity.modelId
      && entry.modelVersion === binding.p2Result.identity.modelVersion
      && entry.runtimeVersion === binding.p2Result.identity.runtimeVersion)
    : [];
  if (!record(input.target) || !exactKeys(input.target, ['packId', 'packVersion', 'manifestSha256', 'platform', 'activationGeneration', 'lifecycleRecordSha256'])
    || input.target.packId !== MAINA_MODEL_PACK_ID || !ID.test(input.target.packVersion)
    || !SHA256.test(input.target.manifestSha256) || !SHA256.test(input.target.lifecycleRecordSha256)
    || !safePositive(input.target.activationGeneration) || !['android', 'ios'].includes(input.target.platform)
    || !validResultMapping(input.successor)
    || !record(counts) || !exactKeys(counts, ['targetManifestSha256', 'targetPlatform', 'targetActivationGeneration', 'pinnedReaderCount', 'resultReferenceCount'])
    || counts.targetManifestSha256 !== input.target.manifestSha256
    || counts.targetPlatform !== input.target.platform
    || counts.targetActivationGeneration !== input.target.activationGeneration
    || !safeNonnegative(counts.pinnedReaderCount) || !safeNonnegative(counts.resultReferenceCount)
    || input.active || input.rollbackRetained || input.inProgress
    || counts.pinnedReaderCount !== 0 || counts.resultReferenceCount !== 0
    || !record(result) || !exactKeys(result, ['resultId', 'resultPayloadSha256'])
    || typeof result.resultId !== 'string' || !ID.test(result.resultId)
    || typeof result.resultPayloadSha256 !== 'string' || !SHA256.test(result.resultPayloadSha256)
    || !validatedResult || exactMapping.length !== 1
    || exactMapping[0].manifestSha256 !== input.successor.manifestSha256
    || exactMapping[0].platform !== input.successor.platform
    || exactMapping[0].activationGeneration !== input.successor.activationGeneration
    || exactMapping[0].lifecycleRecordSha256 !== input.successor.lifecycleRecordSha256
    || binding.p2Result.identity.resultId !== result.resultId
    || binding.p2Result.resultPayloadSha256 !== result.resultPayloadSha256
    || !input.successor.referencedResultIds.includes(result.resultId)
    || input.target.manifestSha256 === input.successor.manifestSha256
    || input.target.platform !== input.successor.platform
    || input.successor.activationGeneration <= input.target.activationGeneration) {
    return { ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' };
  }
  return { ok: true, value: undefined };
}
