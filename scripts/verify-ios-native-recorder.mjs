#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const moduleRoot = path.join(project, 'modules', 'maina-recorder');
const capture = path.join(moduleRoot, 'ios', 'MainaIOSNativeAudioCapture.swift');
const module = path.join(moduleRoot, 'ios', 'MainaRecorderModule.swift');
const qwen = path.join(moduleRoot, 'ios', 'MainaQwenAsr.swift');
const sherpaHeaders = path.join(moduleRoot, 'ios', 'vendor', 'sherpa-onnx.xcframework', 'ios-arm64', 'Headers');
const config = JSON.parse(readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'));
const appConfig = JSON.parse(readFileSync(path.join(project, 'app.json'), 'utf8'));

for (const file of [capture, module, qwen]) {
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
for (const token of [
  'AVAudioSession.routeChangeNotification',
  'AVAudioSession.interruptionNotification',
  'capture-journal.jsonl',
  'partial.wav',
  'chunk-finalization-conflict',
  'allowBluetoothHFP',
  'setPrefersInterruptionOnRouteDisconnect(false)',
]) {
  if (!readFileSync(capture, 'utf8').includes(token)) {
    throw new Error(`iOS recorder reliability invariant missing: ${token}`);
  }
}
for (const token of [
  'startNativeCapture',
  'requestIOSMicrophonePermission',
  'getQwenAsrStatus',
]) {
  if (!readFileSync(module, 'utf8').includes(token)) {
    throw new Error(`iOS module API missing: ${token}`);
  }
}

// This is intentionally a macOS-only static gate; Linux CI still runs TS tests.
if (process.platform === 'darwin') {
  const sdk = execFileSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('xcrun', [
    'swiftc', '-target', 'arm64-apple-ios16.4', '-sdk', sdk,
    '-typecheck', capture,
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
