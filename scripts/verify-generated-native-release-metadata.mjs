#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');

const exact = (actual, expected, field) => {
  if (actual !== expected) throw new Error(`${field}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
};

const valueAfterKey = (source, key, file) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`));
  if (!match) throw new Error(`${file}: missing ${key}`);
  return match[1];
};

export function validateGeneratedNativeReleaseMetadata({ platform, plan, files }) {
  if (!['android', 'ios'].includes(platform)) throw new Error('platform: android or ios is required');
  if (!plan || typeof plan !== 'object') throw new Error('plan: release plan is required');
  if (!files || typeof files !== 'object') throw new Error('files: generated native metadata is required');

  if (platform === 'android') {
    const gradle = files.androidAppBuildGradle;
    if (typeof gradle !== 'string') throw new Error('android/app/build.gradle: generated metadata is required');
    const applicationId = gradle.match(/applicationId\s+['"]([^'"]+)['"]/)?.[1];
    const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1];
    const versionName = gradle.match(/versionName\s+['"]([^'"]+)['"]/)?.[1];
    exact(applicationId, plan.identity.androidPackage, 'android.applicationId');
    exact(versionCode, String(plan.release.androidVersionCode), 'android.versionCode');
    exact(versionName, plan.release.version, 'android.versionName');
  } else {
    const info = files.iosInfoPlist;
    const project = files.iosProjectPbxproj;
    if (typeof info !== 'string') throw new Error('ios/Maina/Info.plist: generated metadata is required');
    if (typeof project !== 'string') throw new Error('ios/Maina.xcodeproj/project.pbxproj: generated metadata is required');
    exact(valueAfterKey(info, 'CFBundleShortVersionString', 'ios/Maina/Info.plist'), plan.release.version, 'ios.CFBundleShortVersionString');
    exact(valueAfterKey(info, 'CFBundleVersion', 'ios/Maina/Info.plist'), plan.release.iosBuildNumber, 'ios.CFBundleVersion');
    const bundleIdentifiers = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)]
      .map((match) => match[1].trim().replace(/^"|"$/g, ''));
    if (!bundleIdentifiers.includes(plan.identity.iosBundleIdentifier)) {
      throw new Error(`ios.PRODUCT_BUNDLE_IDENTIFIER: missing ${plan.identity.iosBundleIdentifier}`);
    }
  }
  return true;
}

function readCanonicalFiles(platform) {
  if (platform === 'android') {
    return { androidAppBuildGradle: readFileSync(path.join(projectRoot, 'android/app/build.gradle'), 'utf8') };
  }
  return {
    iosInfoPlist: readFileSync(path.join(projectRoot, 'ios/Maina/Info.plist'), 'utf8'),
    iosProjectPbxproj: readFileSync(path.join(projectRoot, 'ios/Maina.xcodeproj/project.pbxproj'), 'utf8'),
  };
}

function main() {
  const [platform] = process.argv.slice(2);
  if (!['android', 'ios'].includes(platform)) throw new Error('Usage: verify-generated-native-release-metadata.mjs <android|ios>');
  const plan = JSON.parse(readFileSync(path.join(projectRoot, 'release/m3-m4-0.10.44-candidate-plan.json'), 'utf8'));
  validateGeneratedNativeReleaseMetadata({ platform, plan, files: readCanonicalFiles(platform) });
  console.log(`Generated ${platform} native release metadata exactly matches the 0.10.44 candidate plan.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
