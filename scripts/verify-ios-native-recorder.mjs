#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const moduleRoot = path.join(project, 'modules', 'maina-recorder');
const capture = path.join(moduleRoot, 'ios', 'MainaIOSNativeAudioCapture.swift');
const module = path.join(moduleRoot, 'ios', 'MainaRecorderModule.swift');
const qwen = path.join(moduleRoot, 'ios', 'MainaQwenAsr.swift');
const continuedProcessing = path.join(moduleRoot, 'ios', 'MainaIOSContinuedProcessing.swift');
const continuedProcessingPlugin = path.join(project, 'plugins', 'withMainaIOSContinuedProcessing.js');
const sherpaHeaders = path.join(moduleRoot, 'ios', 'vendor', 'sherpa-onnx.xcframework', 'ios-arm64', 'Headers');
const config = JSON.parse(readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
const appConfig = JSON.parse(readFileSync(path.join(project, 'app.json'), 'utf8'));

for (const file of [capture, module, qwen, continuedProcessing, continuedProcessingPlugin]) {
  if (!existsSync(file) || readFileSync(file, 'utf8').trim().length === 0) {
    throw new Error(`Required iOS recorder source is missing: ${file}`);
  }
}
if (!config.apple?.modules?.includes('MainaRecorderModule')) {
  throw new Error('Expo module config does not register MainaRecorderModule for Apple.');
}
if (!appConfig.expo.ios?.infoPlist?.UIBackgroundModes?.includes('audio')) {
  throw new Error('Maina iOS must declare audio background mode for active recording.');
}
if (!appConfig.expo.ios?.infoPlist?.UIBackgroundModes?.includes('processing')) {
  throw new Error('Maina iOS must declare processing background mode for deferred transcription.');
}
if (!appConfig.expo.ios?.infoPlist?.BGTaskSchedulerPermittedIdentifiers?.includes('com.divay.maina.staging.continued-processing.*')) {
  throw new Error('Maina iOS continued-processing task identifier is not permitted.');
}
if (!appConfig.expo.plugins?.includes('./plugins/withMainaIOSContinuedProcessing')) {
  throw new Error('Maina iOS must install its continued-processing AppDelegate registration plugin.');
}
for (const token of [
  'AVAudioSession.routeChangeNotification',
  'AVAudioSession.interruptionNotification',
  'capture-journal.jsonl',
  'partial.wav',
  'chunk-finalization-conflict',
  'allowBluetoothHFP',
  'setPrefersInterruptionOnRouteDisconnect(false)',
  'AVAudioSession.mediaServicesWereResetNotification',
  'UIApplication.didBecomeActiveNotification',
  'storageReserveBytes',
  'capture-recovery-deferred',
]) {
  if (!readFileSync(capture, 'utf8').includes(token)) {
    throw new Error(`iOS recorder reliability invariant missing: ${token}`);
  }
}
for (const token of [
  'startNativeCapture',
  'requestIOSMicrophonePermission',
  'getQwenAsrStatus',
  'beginIOSContinuedProcessing',
]) {
  if (!readFileSync(module, 'utf8').includes(token)) {
    throw new Error(`iOS module API missing: ${token}`);
  }
}
for (const token of [
  'BGContinuedProcessingTaskRequest',
  'BGTaskScheduler.shared.submit',
  'beginBackgroundTask',
  'setTaskCompleted',
  'public static func registerLaunchHandler()',
  'continued-processing-handler-unregistered',
]) {
  if (!readFileSync(continuedProcessing, 'utf8').includes(token)) {
    throw new Error(`iOS continued-processing invariant missing: ${token}`);
  }
}
for (const token of [
  'withAppDelegate',
  'internal import MainaRecorder',
  'MainaIOSContinuedProcessing.registerLaunchHandler()',
]) {
  if (!readFileSync(continuedProcessingPlugin, 'utf8').includes(token)) {
    throw new Error(`iOS AppDelegate registration invariant missing: ${token}`);
  }
}

// This is intentionally a macOS-only static gate; Linux CI still runs TS tests.
if (process.platform === 'darwin') {
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', capture,
  ], { stdio: 'inherit' });
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', continuedProcessing,
  ], { stdio: 'inherit' });
  if (!existsSync(sherpaHeaders)) {
    throw new Error('Verified Sherpa iOS runtime is missing; run npm run ios:runtime first.');
  }
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-I', sherpaHeaders, '-typecheck', qwen,
  ], { stdio: 'inherit' });
}

console.log('iOS native capture source and capability boundary verified.');
