#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function maskKotlinNonCode(source) {
  let output = '';
  let index = 0;
  let state = 'code';
  let blockDepth = 0;
  const mask = character => character === '\n' || character === '\r' ? character : ' ';
  while (index < source.length) {
    const nextTwo = source.slice(index, index + 2);
    const nextThree = source.slice(index, index + 3);
    const character = source[index];
    if (state === 'code') {
      if (nextTwo === '//') { state = 'line_comment'; output += '  '; index += 2; continue; }
      if (nextTwo === '/*') { state = 'block_comment'; blockDepth = 1; output += '  '; index += 2; continue; }
      if (nextThree === '\"\"\"') { state = 'raw_string'; output += '   '; index += 3; continue; }
      if (character === '\"') { state = 'string'; output += ' '; index += 1; continue; }
      if (character === "'") { state = 'character'; output += ' '; index += 1; continue; }
      output += character;
      index += 1;
      continue;
    }
    if (state === 'line_comment') {
      output += mask(character);
      index += 1;
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block_comment') {
      if (nextTwo === '/*') { blockDepth += 1; output += '  '; index += 2; continue; }
      if (nextTwo === '*/') {
        blockDepth -= 1;
        output += '  ';
        index += 2;
        if (blockDepth === 0) state = 'code';
        continue;
      }
      output += mask(character);
      index += 1;
      continue;
    }
    if (state === 'raw_string') {
      if (nextThree === '\"\"\"') { state = 'code'; output += '   '; index += 3; continue; }
      output += mask(character);
      index += 1;
      continue;
    }
    if (character === '\\') {
      output += ' ';
      index += 1;
      if (index < source.length) { output += mask(source[index]); index += 1; }
      continue;
    }
    output += mask(character);
    index += 1;
    if ((state === 'string' && character === '\"') || (state === 'character' && character === "'")) state = 'code';
  }
  if (state === 'block_comment' || state === 'raw_string' || state === 'string' || state === 'character') {
    throw new Error('Malformed Kotlin source while checking native-recorder invariants.');
  }
  return output;
}

function kotlinFunctionBody(source, functionName) {
  const code = maskKotlinNonCode(source);
  const signature = new RegExp(`\\bfun\\s+${functionName}\\s*\\(`, 'g');
  const matches = [...code.matchAll(signature)];
  if (matches.length !== 1) throw new Error(`Expected exactly one Kotlin function named ${functionName}.`);
  const open = code.indexOf('{', matches[0].index + matches[0][0].length);
  if (open < 0) throw new Error(`Kotlin function ${functionName} must have a block body.`);
  let depth = 1;
  for (let index = open + 1; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}') depth -= 1;
    if (depth === 0) return code.slice(open + 1, index);
  }
  throw new Error(`Kotlin function ${functionName} has an unbalanced block body.`);
}

function balancedBlock(source, open) {
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error('Unbalanced Kotlin block in retained-ready verifier.');
}

function topLevelAcquisition(body) {
  const acceptedAcquisition = /\bval\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:runCatching\s*\{\s*)?modelPacks\s*\.\s*acquireReady\s*\(\s*\)/g;
  for (const acquisition of body.matchAll(acceptedAcquisition)) {
    let depth = 0;
    for (const character of body.slice(0, acquisition.index)) {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
      if (depth < 0) return null;
    }
    if (depth === 0) return { index: acquisition.index, name: acquisition[1] };
  }
  return null;
}

function guardedHandleBranch(body, acquisition) {
  const guard = new RegExp(`\\bif\\s*\\(\\s*${acquisition.name}\\s*!=\\s*null\\s*\\)\\s*\\{`, 'g');
  guard.lastIndex = acquisition.index;
  const match = guard.exec(body);
  if (match === null) return null;
  let depth = 0;
  for (const character of body.slice(0, match.index)) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
  }
  if (depth !== 0) return null;
  const open = body.indexOf('{', match.index);
  return balancedBlock(body, open);
}

function firstRegexIndexAtDepth(source, expression, expectedDepth) {
  const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`;
  const matcher = new RegExp(expression.source, flags);
  for (const match of source.matchAll(matcher)) {
    let depth = 0;
    for (const character of source.slice(0, match.index)) {
      if (character === '{') depth += 1;
      if (character === '}') depth -= 1;
    }
    if (depth === expectedDepth) return match.index;
  }
  return -1;
}

function regexMatchesAtDepth(source, expression, expectedDepth) {
  return firstRegexIndexAtDepth(source, expression, expectedDepth) >= 0;
}

function functionAcquiresRetainedReady(source, functionName) {
  const body = kotlinFunctionBody(source, functionName);
  const acquisition = topLevelAcquisition(body);
  if (acquisition === null) return false;
  const telemetryRead = /\bmodelPacks\s*\.\s*status\s*\(\s*\)/g;
  if ([...body.matchAll(telemetryRead)].some(match => match.index < acquisition.index)) return false;
  const branch = guardedHandleBranch(body, acquisition);
  if (branch === null) return false;
  const escaped = acquisition.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (functionName === 'status') {
    if (/\breturn\b/.test(body.slice(0, acquisition.index))) return false;
    return /^\s*return\s+try\s*\{/.test(branch) &&
      regexMatchesAtDepth(branch, new RegExp(`\\bModelStatus\\s*\\(\\s*true\\s*,\\s*${escaped}\\s*\\.\\s*root`), 1) &&
      regexMatchesAtDepth(branch, /\bfinally\s*\{/, 0) &&
      regexMatchesAtDepth(branch, new RegExp(`\\b${escaped}\\s*\\.\\s*release\\s*\\(\\s*\\)`), 1);
  }
  if (functionName === 'resolveModelForRecognizer') {
    const ordered = [
      firstRegexIndexAtDepth(branch, /\bval\s+selectedIdentity\s*=/, 0),
      firstRegexIndexAtDepth(branch, /\bval\s+invalid\s*=/, 0),
      firstRegexIndexAtDepth(branch, /\bif\s*\(\s*invalid\s*==\s*null\s*\)\s*\{/, 0),
      firstRegexIndexAtDepth(branch, new RegExp(`\\brunCatching\\s*\\{\\s*modelPacks\\s*\\.\\s*rollbackAfterOpenFailure\\s*\\(\\s*${escaped}\\s*\\)`), 0),
      firstRegexIndexAtDepth(branch, new RegExp(`\\brunCatching\\s*\\{\\s*${escaped}\\s*\\.\\s*release\\s*\\(\\s*\\)`), 0),
      firstRegexIndexAtDepth(branch, /\berror\s*\(/, 0),
    ];
    const topLevelReturn = firstRegexIndexAtDepth(branch, /\breturn\b/, 0);
    return ordered.every(index => index >= 0) && ordered.every((index, position) => position === 0 || index > ordered[position - 1]) &&
      (topLevelReturn < 0 || topLevelReturn > ordered[5]) &&
      regexMatchesAtDepth(branch, new RegExp(`\\bactivePack\\s*=\\s*${escaped}\\b`), 1) &&
      regexMatchesAtDepth(branch, /\bpinnedModelIdentity\s*=/, 1) &&
      regexMatchesAtDepth(branch, new RegExp(`\\breturn\\s+ModelStatus\\s*\\(\\s*true\\s*,\\s*${escaped}\\s*\\.\\s*root`), 1);
  }
  return false;
}

function verifyReadyAcquisitionFixture(source, expected) {
  const observed = functionAcquiresRetainedReady(source, 'status') &&
    functionAcquiresRetainedReady(source, 'resolveModelForRecognizer');
  if (observed !== expected) throw new Error('Android retained-ready static verifier fixture failed.');
}

function functionHasOrderedTokens(source, functionName, tokens) {
  const body = kotlinFunctionBody(source, functionName);
  let cursor = 0;
  for (const token of tokens) {
    const index = body.indexOf(token, cursor);
    if (index < 0) return false;
    cursor = index + token.length;
  }
  return true;
}

verifyReadyAcquisitionFixture(`
  fun status() { val handle = modelPacks.acquireReady(); if (handle != null) { return try { ModelStatus(true, handle.root.path) } finally { handle.release() } }; return legacy() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { val selectedIdentity = identity(handle); val invalid = invalid(handle.root); if (invalid == null) { activePack = handle; pinnedModelIdentity = selectedIdentity; return ModelStatus(true, handle.root.path) }; runCatching { modelPacks.rollbackAfterOpenFailure(handle) }; runCatching { handle.release() }; error("bad") }; return legacy() }
`, true);
verifyReadyAcquisitionFixture(`
  fun status() { val handle = runCatching { modelPacks.acquireReady() }.getOrElse { error("bad") }; if (handle != null) { return try { ModelStatus(true, handle.root.path) } finally { handle.release() } }; return legacy() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { val selectedIdentity = identity(handle); val invalid = invalid(handle.root); if (invalid == null) { activePack = handle; pinnedModelIdentity = selectedIdentity; return ModelStatus(true, handle.root.path) }; runCatching { modelPacks.rollbackAfterOpenFailure(handle) }; runCatching { handle.release() }; error("bad") }; return legacy() }
`, true);
verifyReadyAcquisitionFixture(`
  fun status() { val root = modelRoot() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady() }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { /* val handle = modelPacks.acquireReady() */ val text = \"modelPacks.acquireReady()\" }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { activePack = handle } }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { val lifecycleStatus = modelPacks.status(); val handle = modelPacks.acquireReady() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { activePack = handle } }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { val deferred = { modelPacks.acquireReady() } }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { activePack = handle } }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { if (false) { val handle = modelPacks.acquireReady() } }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { activePack = handle } }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { return legacy(); val handle = modelPacks.acquireReady(); if (handle != null) { return try { ok(handle.root) } finally { handle.release() } } }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { val selectedIdentity = identity(handle); val invalid = invalid(handle.root); if (invalid == null) { activePack = handle; pinnedModelIdentity = selectedIdentity; return ok() }; runCatching { modelPacks.rollbackAfterOpenFailure(handle) }; runCatching { handle.release() }; error("bad") } }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { val handle = modelPacks.acquireReady(); if (handle != null) { handle.release() }; return legacy() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { return legacy() }; return legacy() }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { val handle = modelPacks.acquireReady(); if (handle != null) { if (false) { return try { ok(handle.root) } finally { handle.release() } }; return legacy() }; return legacy() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { if (false) { val selectedIdentity = identity(handle); val invalid = invalid(handle.root); if (invalid == null) { activePack = handle; pinnedModelIdentity = selectedIdentity; return ok() }; runCatching { modelPacks.rollbackAfterOpenFailure(handle) }; runCatching { handle.release() }; error("bad") }; return legacy() }; return legacy() }
`, false);
verifyReadyAcquisitionFixture(`
  fun status() { val handle = modelPacks.acquireReady(); if (handle != null) { return try { if (false) { ModelStatus(true, handle.root.path) }; ModelStatus(false, legacy()) } finally { handle.release() } }; return legacy() }
  fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady(); if (handle != null) { val selectedIdentity = identity(handle); val invalid = invalid(handle.root); if (invalid == null) { activePack = handle; pinnedModelIdentity = selectedIdentity; return ModelStatus(true, handle.root.path) }; return legacy(); runCatching { modelPacks.rollbackAfterOpenFailure(handle) }; runCatching { handle.release() }; error("bad") }; return legacy() }
`, false);
try {
  verifyReadyAcquisitionFixture(`
    fun status() { val handle = modelPacks.acquireReady()
    fun resolveModelForRecognizer() { val handle = modelPacks.acquireReady() }
  `, true);
  throw new Error('Malformed Kotlin verifier fixture was accepted.');
} catch (error) {
  if (error.message === 'Malformed Kotlin verifier fixture was accepted.') throw error;
}

if (!functionHasOrderedTokens(`
  fun finish() { database.beginTransaction(); update(); bindExactResultBeforeCommit(result); database.setTransactionSuccessful(); database.endTransaction() }
`, 'finish', ['beginTransaction()', 'bindExactResultBeforeCommit(result)', 'setTransactionSuccessful()', 'endTransaction()'])) {
  throw new Error('Terminal model-result fence positive fixture failed.');
}
if (functionHasOrderedTokens(`
  fun finish() { database.beginTransaction(); update(); database.setTransactionSuccessful(); bindExactResultBeforeCommit(result); database.endTransaction() }
`, 'finish', ['beginTransaction()', 'bindExactResultBeforeCommit(result)', 'setTransactionSuccessful()', 'endTransaction()'])) {
  throw new Error('Terminal model-result fence reorder fixture was accepted.');
}

const project = path.resolve(import.meta.dirname, '..');
const moduleRoot = path.join(project, 'modules', 'maina-recorder');
const androidRoot = path.join(moduleRoot, 'android');

const requiredFiles = [
  'expo-module.config.json',
  'package.json',
  'android/build.gradle',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaPostProcessingRecoveryWorker.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaQwenAsr.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaModelPackLifecycle.kt',
  'android/src/test/java/com/divay/maina/recorder/MainaModelPackLifecycleTest.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaVoiceActivity.kt',
  'android/src/main/java/com/divay/maina/recorder/MainaHardwareTrigger.kt',
  'android/src/main/assets/silero_vad.int8.onnx',
  'android/libs/sherpa-onnx-1.13.6.aar',
];

for (const relative of requiredFiles) {
  const target = path.join(moduleRoot, relative);
  if (!existsSync(target) || statSync(target).size === 0) {
    throw new Error(`Required native recorder source is missing or empty: ${relative}`);
  }
}

const config = JSON.parse(readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
if (!config.android?.modules?.includes('com.divay.maina.recorder.MainaRecorderModule')) {
  throw new Error('expo-module.config.json does not register MainaRecorderModule for Android.');
}

const gradle = readFileSync(path.join(androidRoot, 'build.gradle'), 'utf8');
if (!/implementation\s+files\('libs\/sherpa-onnx-1\.13\.6\.aar'\)/.test(gradle)) {
  throw new Error('Sherpa runtime must be an implementation dependency, never compileOnly.');
}

const qwen = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaQwenAsrPolicy.kt'), 'utf8');
for (const invariant of [
  'const val maxTotalLen = 512',
  'const val maxNewTokens = 128',
  'const val inferenceThreads = 2',
]) {
  if (!qwen.includes(invariant)) throw new Error(`Qwen resource invariant missing: ${invariant}`);
}
const modelPackLifecycle = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaModelPackLifecycle.kt'), 'utf8');
for (const invariant of [
  'maina.model-pack-manifest.v1',
  'same_manifest_and_verified_prefix',
  'same_manifest_invalid_bytes_removed',
  'MODEL_PACK_WRITER_CONFLICT',
  'MODEL_PACK_READER_PIN_FAILED',
  'rollbackAfterOpenFailure',
  'interruptedPromotionAction',
  'CURRENT_ACQUISITION',
  'readLifecycleManifest',
  'DOWNLOAD_WRITE_FAILED',
  'resultPayloadSha256',
  'StandardCopyOption.ATOMIC_MOVE',
  '0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698',
]) {
  if (!modelPackLifecycle.includes(invariant)) throw new Error(`Android model-pack lifecycle invariant missing: ${invariant}`);
}
const qwenAdapter = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaQwenAsr.kt'), 'utf8');
if (createHash('sha256').update(qwenAdapter).digest('hex') !== 'dd7836edc81f1c7434eb0abf790b07932f86e10055dac56269a6357043bbd3a7') {
  throw new Error('Android Qwen serving control flow changed without updating its exact reviewed source invariant.');
}
for (const invariant of [
  'MainaModelPackLifecycle(context)',
  'modelPacks.acquireReady()',
  'rollbackAfterOpenFailure',
  'activePack?.let { runCatching { it.release() } }',
  'fun modelIdentity()',
  'fun bindExactResultBeforeCommit(result: Map<String, Any?>)',
  'fun commitExactResult(result: Map<String, Any?>)',
  'fun smoke(root: File, uriOrPath: String)',
]) {
  if (!qwenAdapter.includes(invariant)) throw new Error(`Android Qwen model-pack integration invariant missing: ${invariant}`);
}
const postProcessingOutboxSource = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt'), 'utf8');
if (!functionHasOrderedTokens(postProcessingOutboxSource, 'finish', [
  'beginTransaction()',
  'bindExactResultBeforeCommit(result)',
  'setTransactionSuccessful()',
  'endTransaction()',
])) {
  throw new Error('Terminal native result must install its exact model fence before the Outbox commit.');
}
const postProcessingServiceSource = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt'), 'utf8');
if (!functionHasOrderedTokens(postProcessingServiceSource, 'runPostProcessing', [
  'outbox.finish(',
  'asr.bindExactResultBeforeCommit(result)',
  'asr.commitExactResult(terminalResult)',
  'return coverageComplete',
  'asr.release()',
])) {
  throw new Error('Post-processing must bind the exact result before releasing its model reader.');
}
if (!functionAcquiresRetainedReady(qwenAdapter, 'status') ||
    !functionAcquiresRetainedReady(qwenAdapter, 'resolveModelForRecognizer')) {
  throw new Error('Android Qwen status and recognition must acquire retained ready before interpreting acquisition telemetry.');
}
for (const invariant of ['pinnedModelIdentity', 'MODEL_PACK_IDENTITY_CHANGED', 'MODEL_PACK_IDENTITY_UNAVAILABLE']) {
  if (!qwenAdapter.includes(invariant)) throw new Error(`Android Qwen per-run model identity fence missing: ${invariant}`);
}
const recorderModule = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt'), 'utf8');
for (const invariant of [
  'getNativeModelPackLifecycleStatus',
  'beginNativeModelPackAcquisition',
  'stageNativeModelPackChunk',
  'verifyAndPromoteNativeModelPack',
  'lifecycle.noteExactResult(',
  'NATIVE_MODEL_RESULT_BINDING_FAILED',
]) {
  if (!recorderModule.includes(invariant)) throw new Error(`Android model-pack bridge invariant missing: ${invariant}`);
}

const postProcessing = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt'), 'utf8');
for (const invariant of [
  'modelIdentity = asr.modelIdentity()',
  'MainaPostProcessingSupport.splitForRetry(window, asr.lowestEnergySplit(uri, window))',
  'MAX_RECOVERY_DEPTH = 2',
  'MAX_RECOVERY_PIECES = 4',
  'asr.release()',
  'override fun onTimeout',
  'WindowEvidence',
  'MainaVoiceActivity',
  'WINDOW_SKIPPED_SILENCE',
  'WINDOW_RETRY_PENDING',
]) {
  if (!postProcessing.includes(invariant)) throw new Error(`Post-processing reliability invariant missing: ${invariant}`);
}

const postProcessingOutbox = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt'), 'utf8');
for (const invariant of [
  'model_manifest_sha256',
  'model_activation_generation',
  'native_model_identity_conflict',
  'DB_VERSION = 7',
  'CREATE TABLE IF NOT EXISTS discarded_meetings',
  'check(!isDiscarded(writableDatabase, meetingId))',
  'INSERT OR IGNORE INTO discarded_meetings',
]) {
  if (!postProcessingOutbox.includes(invariant)) throw new Error(`Post-processing model identity invariant missing: ${invariant}`);
}

const manifest = readFileSync(path.join(androidRoot, 'src/main/AndroidManifest.xml'), 'utf8');
for (const symbol of [
  'MainaRecordingService',
  'MainaPostProcessingService',
  'MainaCommandReceiver',
  'MainaKeyAccessibilityService',
  'android:process=":asr"',
  'FOREGROUND_SERVICE_MICROPHONE',
  'FOREGROUND_SERVICE_MEDIA_PROCESSING',
]) {
  if (!manifest.includes(symbol)) throw new Error(`Native recorder manifest is missing ${symbol}.`);
}
if (!/<receiver\s+[\s\S]*?android:name="com\.divay\.maina\.recorder\.MainaCommandReceiver"[\s\S]*?android:exported="false"[\s\S]*?>/.test(manifest)) {
  throw new Error('Native recorder command receiver must be explicitly non-exported.');
}

const aar = path.join(androidRoot, 'libs', 'sherpa-onnx-1.13.6.aar');
const archive = execFileSync('unzip', ['-l', aar], { encoding: 'utf8' });
for (const entry of [
  'classes.jar',
  'jni/arm64-v8a/libonnxruntime.so',
  'jni/arm64-v8a/libsherpa-onnx-jni.so',
]) {
  if (!archive.includes(entry)) throw new Error(`Sherpa runtime AAR is missing ${entry}.`);
}

const vadAsset = path.join(androidRoot, 'src/main/assets/silero_vad.int8.onnx');
const vadHash = createHash('sha256').update(readFileSync(vadAsset)).digest('hex');
if (vadHash !== 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20') {
  throw new Error(`Bundled Silero VAD asset checksum mismatch: ${vadHash}`);
}
const vadSource = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaVoiceActivity.kt'), 'utf8');
for (const invariant of [
  'SileroVadModelConfig',
  'windowSize = FRAME_SAMPLES',
  'MainaVoiceActivityPolicy',
  'MODEL_SHA256',
]) {
  if (!vadSource.includes(invariant)) throw new Error(`VAD reliability invariant missing: ${invariant}`);
}
const sherpaClasses = execFileSync('unzip', ['-p', aar, 'classes.jar']);
if (!sherpaClasses.toString('latin1').includes('com/k2fsa/sherpa/onnx/Vad.class')) {
  throw new Error('Sherpa runtime AAR is missing the Android-native VAD API.');
}

console.log('Native recorder source and sherpa runtime integrity verified.');
