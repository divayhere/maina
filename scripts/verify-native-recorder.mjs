#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

const postProcessing = readFileSync(path.join(androidRoot, 'src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt'), 'utf8');
for (const invariant of [
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
