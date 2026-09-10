import { describe, expect, it } from 'vitest';

import {
  canonicalModelPackManifestJson,
  decodeNativeModelPackManifest,
  nativeModelPackCleanupEligible,
  type NativeModelPackManifest,
  type NativeModelPackObservedFile,
  type NativeModelPackResultMapping,
  validateNativeModelPack,
  validateNativeModelPackPromotion,
  validateNativeModelPackResultMapping,
  validateNativeModelPackResume,
  validateNativeModelPackSmokeReceipt,
  validateNativeModelPackStorage,
  validateNativeModelPackTransition,
} from './nativeModelPackLifecycle';

function fixture(): { manifest: NativeModelPackManifest; observedFiles: NativeModelPackObservedFile[] } {
  const files = [
    ['conv_frontend.onnx', 44_148_281, '1'],
    ['encoder.int8.onnx', 182_491_662, '2'],
    ['decoder.int8.onnx', 755_914_231, '3'],
    ['tokenizer/vocab.json', 2_776_833, '4'],
    ['tokenizer/merges.txt', 1_671_853, '5'],
    ['tokenizer/tokenizer_config.json', 12_487, '6'],
  ] as const;
  const manifest: NativeModelPackManifest = {
    schemaVersion: 'maina.model-pack-manifest.v1',
    packId: 'qwen3-asr-0.6b-int8',
    packVersion: 'synthetic-1',
    engineId: 'qwen3-0.6b-int8',
    formatVersion: '1',
    files: files.map(([path, byteCount, hex]) => ({
      path,
      byteCount,
      sha256: hex.repeat(64),
      chunkSizeBytes: 1_073_741_824,
      chunkSha256: [hex.repeat(64)],
    })),
    platforms: [
      { osFamily: 'android', minOsVersion: '26', architectures: ['arm64-v8a'], runtimeVersion: 'sherpa-onnx-1.13.6', runtimeSha256: 'a'.repeat(64), smokeExpectedTextSha256: 'c'.repeat(64) },
      { osFamily: 'ios', minOsVersion: '17.0', architectures: ['arm64'], runtimeVersion: 'sherpa-onnx-1.13.4-ios-no-tts', runtimeSha256: 'b'.repeat(64), smokeExpectedTextSha256: 'd'.repeat(64) },
    ],
    smokeInputSha256: 'e'.repeat(64),
    manifestSha256: '0'.repeat(64),
  };
  // Native owns SHA-256. The shared layer emits deterministic RFC 8785 input
  // and compares the native-computed digest with this declared value.
  expect(canonicalModelPackManifestJson(manifest)).not.toContain('manifestSha256');
  manifest.manifestSha256 = 'f'.repeat(64);
  return {
    manifest,
    observedFiles: manifest.files.map((file) => ({
      path: file.path, kind: 'regular', byteCount: file.byteCount, sha256: file.sha256, chunkSha256: [...file.chunkSha256],
    })),
  };
}

function validate(overrides: Partial<Parameters<typeof validateNativeModelPack>[1]> = {}) {
  const { manifest, observedFiles } = fixture();
  return validateNativeModelPack(manifest, {
    computedManifestSha256: manifest.manifestSha256,
    observedFiles,
    platform: 'android',
    osVersion: '36',
    architecture: 'arm64-v8a',
    runtimeVersion: 'sherpa-onnx-1.13.6',
    runtimeSha256: 'a'.repeat(64),
    ...overrides,
  });
}

describe('native model-pack manifest', () => {
  it('accepts the exact closed manifest, platform and observed file evidence', () => {
    expect(validate()).toMatchObject({ ok: true });
  });

  it('rejects unknown root, file and platform fields', () => {
    const variants = [
      { ...fixture().manifest, privatePath: '/tmp/private' },
      { ...fixture().manifest, files: [{ ...fixture().manifest.files[0], extra: true }, ...fixture().manifest.files.slice(1)] },
      { ...fixture().manifest, platforms: [{ ...fixture().manifest.platforms[0], extra: true }, fixture().manifest.platforms[1]] },
    ];
    for (const value of variants) expect(decodeNativeModelPackManifest(value).ok).toBe(false);
  });

  it('rejects scalar coercion and bounds dotted versions without Number narrowing', () => {
    const variants: unknown[] = [
      { ...fixture().manifest, packVersion: 1 },
      { ...fixture().manifest, files: [{ ...fixture().manifest.files[0], byteCount: '44148281' }, ...fixture().manifest.files.slice(1)] },
      { ...fixture().manifest, files: [{ ...fixture().manifest.files[0], chunkSizeBytes: Number.MAX_SAFE_INTEGER + 1 }, ...fixture().manifest.files.slice(1)] },
      { ...fixture().manifest, files: [{ ...fixture().manifest.files[0], chunkSha256: [1] }, ...fixture().manifest.files.slice(1)] },
      { ...fixture().manifest, platforms: [{ ...fixture().manifest.platforms[0], osFamily: { value: 'android' } }, fixture().manifest.platforms[1]] },
      { ...fixture().manifest, platforms: [{ ...fixture().manifest.platforms[0], minOsVersion: 26 }, fixture().manifest.platforms[1]] },
      { ...fixture().manifest, platforms: [{ ...fixture().manifest.platforms[0], architectures: [64] }, fixture().manifest.platforms[1]] },
      { ...fixture().manifest, platforms: { 0: fixture().manifest.platforms[0] } },
      { ...fixture().manifest, platforms: [null, fixture().manifest.platforms[1]] },
      { ...fixture().manifest, platforms: [{ ...fixture().manifest.platforms[0], minOsVersion: '9'.repeat(65) }, fixture().manifest.platforms[1]] },
    ];
    for (const value of variants) expect(decodeNativeModelPackManifest(value)).toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });

    const hugeMinimum = fixture();
    hugeMinimum.manifest.platforms[0].minOsVersion = '9'.repeat(32);
    expect(validateNativeModelPack(hugeMinimum.manifest, {
      computedManifestSha256: hugeMinimum.manifest.manifestSha256,
      observedFiles: hugeMinimum.observedFiles,
      platform: 'android',
      osVersion: '36',
      architecture: 'arm64-v8a',
      runtimeVersion: 'sherpa-onnx-1.13.6',
      runtimeSha256: 'a'.repeat(64),
    })).toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
  });

  it('uses one bounded ASCII dotted-version grammar for manifest and runtime values', () => {
    const validComparisons = [
      ['17', '17', true],
      ['17.0', '17', true],
      ['17.0.0', '17.0', true],
      ['17.0.1', '17.0', true],
      ['18', '17.99999999999999999999999999999999', true],
      ['00017.00', '17.0.0', true],
      ['17', '00017.00', true],
      ['17', '99999999999999999999999999999999', false],
      ['17.1', '17.99999999999999999999999999999999', false],
      ['17.1.1', '17.1.99999999999999999999999999999999', false],
    ] as const;
    for (const [actual, minimum, compatible] of validComparisons) {
      const current = fixture();
      current.manifest.platforms[0].minOsVersion = minimum;
      expect(validateNativeModelPack(current.manifest, {
        computedManifestSha256: current.manifest.manifestSha256,
        observedFiles: current.observedFiles,
        platform: 'android',
        osVersion: actual,
        architecture: 'arm64-v8a',
        runtimeVersion: 'sherpa-onnx-1.13.6',
        runtimeSha256: 'a'.repeat(64),
      }).ok).toBe(compatible);
    }

    const invalidVersions: unknown[] = [
      '', '17.', '.17', '17..0', '17.0.0.0', '-17', '+17', ' 17', '17 ', '17\n',
      '１７', '١٧', '9'.repeat(65), 17, null,
    ];
    for (const invalid of invalidVersions) {
      const current = fixture();
      current.manifest.platforms[0].minOsVersion = invalid as string;
      expect(decodeNativeModelPackManifest(current.manifest))
        .toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
      expect(() => validate({ osVersion: invalid as string })).not.toThrow();
      expect(validate({ osVersion: invalid as string }))
        .toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
    }

    const boundary = fixture();
    boundary.manifest.platforms[0].minOsVersion = `1.${'0'.repeat(62)}`;
    expect(boundary.manifest.platforms[0].minOsVersion).toHaveLength(64);
    expect(decodeNativeModelPackManifest(boundary.manifest).ok).toBe(true);
  });

  it('classifies platform structure separately from platform cardinality and identity', () => {
    const android = fixture().manifest.platforms[0];
    const ios = fixture().manifest.platforms[1];
    for (const platforms of [[], [android], [android, android], [android, ios, ios]]) {
      expect(decodeNativeModelPackManifest({ ...fixture().manifest, platforms }))
        .toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
    }
    for (const platforms of [
      [null, ios],
      [{ ...android, osFamily: 'windows' }, ios],
      [{ ...android, minOsVersion: 26 }, ios],
      [{ ...android, architectures: ['arm64-v8a', 64] }, ios],
    ]) {
      expect(decodeNativeModelPackManifest({ ...fixture().manifest, platforms }))
        .toMatchObject({ ok: false, code: 'MANIFEST_INVALID' });
    }
  });

  it('rejects traversal, absolute, duplicate and case-fold-colliding paths', () => {
    for (const path of ['../conv_frontend.onnx', '/conv_frontend.onnx', 'tokenizer//vocab.json', 'tokenizer\\vocab.json']) {
      const { manifest } = fixture();
      manifest.files[0].path = path;
      expect(decodeNativeModelPackManifest(manifest)).toMatchObject({ ok: false, code: 'MANIFEST_PATH_INVALID' });
    }
    const { manifest } = fixture();
    manifest.files.push({ ...manifest.files[0], path: 'CONV_FRONTEND.ONNX' });
    expect(decodeNativeModelPackManifest(manifest)).toMatchObject({ ok: false, code: 'MANIFEST_PATH_INVALID' });
  });

  it('rejects missing files and required byte-count drift', () => {
    const { manifest } = fixture();
    manifest.files.pop();
    expect(decodeNativeModelPackManifest(manifest)).toMatchObject({ ok: false, code: 'MANIFEST_FILE_SET_MISMATCH' });
    const changed = fixture().manifest;
    changed.files[0].byteCount += 1;
    expect(decodeNativeModelPackManifest(changed)).toMatchObject({ ok: false, code: 'MANIFEST_FILE_SET_MISMATCH' });
  });

  it('rejects manifest self-hash, runtime, OS and architecture substitution', () => {
    expect(validate({ computedManifestSha256: '0'.repeat(64) })).toMatchObject({ ok: false, code: 'MANIFEST_HASH_MISMATCH' });
    expect(validate({ runtimeVersion: 'sherpa-onnx-other' })).toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
    expect(validate({ osVersion: '25' })).toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
    expect(validate({ architecture: 'x86_64' })).toMatchObject({ ok: false, code: 'PLATFORM_COMPATIBILITY_MISMATCH' });
  });

  it('rejects symlink-shaped, size, file-hash and chunk-hash evidence', () => {
    const base = fixture();
    expect(validate({ observedFiles: [{ ...base.observedFiles[0], kind: 'symlink' as never }, ...base.observedFiles.slice(1)] }))
      .toMatchObject({ ok: false, code: 'FILE_EVIDENCE_MISMATCH' });
    for (const changed of [
      { ...base.observedFiles[0], byteCount: base.observedFiles[0].byteCount + 1 },
      { ...base.observedFiles[0], sha256: '9'.repeat(64) },
      { ...base.observedFiles[0], chunkSha256: ['9'.repeat(64)] },
    ]) {
      expect(validate({ observedFiles: [changed, ...base.observedFiles.slice(1)] }))
        .toMatchObject({ ok: false, code: 'FILE_EVIDENCE_MISMATCH' });
    }
  });

  it('returns a bounded mismatch instead of throwing on malformed observed values', () => {
    const base = fixture();
    for (const changed of [
      { ...base.observedFiles[0], byteCount: -1 },
      { ...base.observedFiles[0], sha256: 'nope' },
      { ...base.observedFiles[0], chunkSha256: null },
      { ...base.observedFiles[0], chunkSha256: ['nope'] },
    ]) {
      expect(() => validate({ observedFiles: [changed as never, ...base.observedFiles.slice(1)] })).not.toThrow();
      expect(validate({ observedFiles: [changed as never, ...base.observedFiles.slice(1)] }))
        .toMatchObject({ ok: false, code: 'FILE_EVIDENCE_MISMATCH' });
    }
  });
});

describe('native model-pack lifecycle policy', () => {
  it('allows only contract transitions', () => {
    expect(validateNativeModelPackTransition('downloading', 'verifying', 'all_declared_bytes_present').ok).toBe(true);
    expect(validateNativeModelPackTransition('downloading', 'staged', 'all_declared_bytes_present'))
      .toMatchObject({ ok: false, code: 'LIFECYCLE_TRANSITION_INVALID' });
  });

  it('resumes only an exact verified chunk prefix', () => {
    const { manifest } = fixture();
    const record = { manifestSha256: manifest.manifestSha256, platform: 'android' as const, path: manifest.files[0].path, byteCount: manifest.files[0].byteCount, verifiedChunkSha256: [...manifest.files[0].chunkSha256] };
    expect(validateNativeModelPackResume(record, record, manifest)).toEqual({ ok: true, value: 1 });
    expect(validateNativeModelPackResume(record, { ...record, manifestSha256: '9'.repeat(64) }, manifest))
      .toMatchObject({ ok: false, code: 'RESUME_IDENTITY_MISMATCH' });
    expect(validateNativeModelPackResume({ ...record, verifiedChunkSha256: ['9'.repeat(64)] }, { ...record, verifiedChunkSha256: ['9'.repeat(64)] }, manifest))
      .toMatchObject({ ok: false, code: 'RESUME_PREFIX_INVALID' });
  });

  it('preflights complete retained storage without deleting rollback', () => {
    expect(validateNativeModelPackStorage({ newPackBytes: 10, partialOverheadBytes: 2, retainedRollbackBytes: 10, safetyMarginBytes: 5, availableBytes: 27 }))
      .toEqual({ ok: true, value: 27 });
    expect(validateNativeModelPackStorage({ newPackBytes: 10, partialOverheadBytes: 2, retainedRollbackBytes: 10, safetyMarginBytes: 5, availableBytes: 26 }))
      .toMatchObject({ ok: false, code: 'STORAGE_PREFLIGHT_FAILED' });
  });

  it('binds smoke success to the exact manifest platform runtime input and output', () => {
    const { manifest } = fixture();
    const receipt = { manifestSha256: manifest.manifestSha256, platform: 'android' as const, runtimeVersion: 'sherpa-onnx-1.13.6', runtimeSha256: 'a'.repeat(64), inputSha256: 'e'.repeat(64), normalizedTextSha256: 'c'.repeat(64), startedAt: 1, completedAt: 2, status: 'passed' as const };
    expect(validateNativeModelPackSmokeReceipt(receipt, manifest, 'android').ok).toBe(true);
    expect(validateNativeModelPackSmokeReceipt({ ...receipt, inputSha256: '9'.repeat(64) }, manifest, 'android'))
      .toMatchObject({ ok: false, code: 'SMOKE_RECEIPT_MISMATCH' });
  });

  it('requires atomic durable promotion while retaining the previous ready pack', () => {
    const good = { manifestVerified: true, platformCompatible: true, smokePassed: true, previousReadyRetained: true, conflictingWriter: false, pointerAction: 'atomic_replace', stagedFsync: true, pointerFsync: true, parentFsync: true, readyPublishedAfterDurability: true, deletedPreviousBeforeReady: false };
    expect(validateNativeModelPackPromotion(good).ok).toBe(true);
    expect(validateNativeModelPackPromotion({ ...good, pointerAction: 'copy_then_delete' }))
      .toMatchObject({ ok: false, code: 'PROMOTION_PRECONDITION_FAILED' });
    expect(validateNativeModelPackPromotion({ ...good, previousReadyRetained: false }))
      .toMatchObject({ ok: false, code: 'PROMOTION_PRECONDITION_FAILED' });
  });
});

describe('model identity retention and cleanup', () => {
  function mapping(overrides: Partial<NativeModelPackResultMapping> = {}): NativeModelPackResultMapping {
    return { packId: 'qwen3-asr-0.6b-int8', packVersion: 'synthetic-1', manifestSha256: '1'.repeat(64), platform: 'android', activationGeneration: 2, modelId: 'qwen3-0.6b-int8', modelVersion: 'synthetic-1', runtimeVersion: 'sherpa-onnx-1.13.6', lifecycleRecordSha256: '2'.repeat(64), packRetained: true, referencedResultIds: ['result-1'], ...overrides };
  }

  it('forbids reusing a P2 tuple for another manifest or generation', () => {
    const current = mapping();
    expect(validateNativeModelPackResultMapping(current, []).ok).toBe(true);
    expect(validateNativeModelPackResultMapping(mapping({ manifestSha256: '3'.repeat(64) }), [current]))
      .toMatchObject({ ok: false, code: 'RESULT_BINDING_MISMATCH' });
    expect(validateNativeModelPackResultMapping(current, [current, mapping({ manifestSha256: '3'.repeat(64) })]))
      .toMatchObject({ ok: false, code: 'RESULT_BINDING_MISMATCH' });
  });

  it('collects only an unreferenced non-active target after an exact successor result', () => {
    const successor = mapping();
    const target = { packId: 'qwen3-asr-0.6b-int8' as const, packVersion: 'synthetic-0', manifestSha256: '3'.repeat(64), platform: 'android' as const, activationGeneration: 1, lifecycleRecordSha256: '4'.repeat(64) };
    const good = {
      target,
      successor,
      firstExactSuccessorResult: { resultId: 'result-1', resultPayloadSha256: '5'.repeat(64) },
      validatedResultBinding: {
        p2Result: { identity: { resultId: 'result-1', modelId: successor.modelId, modelVersion: successor.modelVersion, runtimeVersion: successor.runtimeVersion }, resultPayloadSha256: '5'.repeat(64) },
        lifecycleMappings: [successor],
      },
      scopedCounts: { targetManifestSha256: target.manifestSha256, targetPlatform: target.platform, targetActivationGeneration: target.activationGeneration, pinnedReaderCount: 0, resultReferenceCount: 0 },
      active: false,
      rollbackRetained: false,
      inProgress: false,
    };
    expect(nativeModelPackCleanupEligible(good).ok).toBe(true);
    expect(nativeModelPackCleanupEligible({ ...good, scopedCounts: { ...good.scopedCounts, pinnedReaderCount: 1 } }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, rollbackRetained: true }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, firstExactSuccessorResult: { ...good.firstExactSuccessorResult, resultId: 'other' } }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, successor: mapping({ activationGeneration: 1 }) }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, scopedCounts: { ...good.scopedCounts, targetManifestSha256: '9'.repeat(64) } }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, firstExactSuccessorResult: { ...good.firstExactSuccessorResult, resultPayloadSha256: '9'.repeat(64) } }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
    expect(nativeModelPackCleanupEligible({ ...good, validatedResultBinding: { ...good.validatedResultBinding, lifecycleMappings: [successor, mapping({ manifestSha256: '9'.repeat(64) })] } }))
      .toMatchObject({ ok: false, code: 'CLEANUP_BOUNDARY_MISMATCH' });
  });
});
