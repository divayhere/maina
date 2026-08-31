#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';

const [platform] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform)) {
  throw new Error('Usage: verify-generated-native-release-metadata.mjs <android|ios>');
}

const root = path.resolve(import.meta.dirname, '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const plan = JSON.parse(read('release/m3-m4-0.10.43-candidate-plan.json'));
const exact = (actual, expected, field) => {
  if (actual !== expected) throw new Error(`${field}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
};
const valueAfterKey = (source, key, file) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`));
  if (!match) throw new Error(`${file}: missing ${key}`);
  return match[1];
};

if (platform === 'android') {
  const gradle = read('android/app/build.gradle');
  const applicationId = gradle.match(/applicationId\s+['"]([^'"]+)['"]/)?.[1];
  const versionCode = gradle.match(/versionCode\s+(\d+)/)?.[1];
  const versionName = gradle.match(/versionName\s+['"]([^'"]+)['"]/)?.[1];
  exact(applicationId, plan.identity.androidPackage, 'android.applicationId');
  exact(versionCode, String(plan.release.androidVersionCode), 'android.versionCode');
  exact(versionName, plan.release.version, 'android.versionName');
} else {
  const info = read('ios/Maina/Info.plist');
  const project = read('ios/Maina.xcodeproj/project.pbxproj');
  exact(valueAfterKey(info, 'CFBundleShortVersionString', 'ios/Maina/Info.plist'), plan.release.version, 'ios.CFBundleShortVersionString');
  exact(valueAfterKey(info, 'CFBundleVersion', 'ios/Maina/Info.plist'), plan.release.iosBuildNumber, 'ios.CFBundleVersion');
  const bundleIdentifiers = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)].map((match) => match[1].trim().replace(/^"|"$/g, ''));
  if (!bundleIdentifiers.includes(plan.identity.iosBundleIdentifier)) {
    throw new Error(`ios.PRODUCT_BUNDLE_IDENTIFIER: missing ${plan.identity.iosBundleIdentifier}`);
  }
}

console.log(`Generated ${platform} native release metadata exactly matches the 0.10.43 candidate plan.`);
