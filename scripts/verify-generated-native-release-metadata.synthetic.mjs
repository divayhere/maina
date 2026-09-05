import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateGeneratedNativeReleaseMetadata } from './verify-generated-native-release-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const plan = JSON.parse(readFileSync(path.join(root, 'release/m3-m4-0.10.48-candidate-plan.json'), 'utf8'));
const generatedPaths = [
  path.join(root, 'android/app/build.gradle'),
  path.join(root, 'ios/Maina/Info.plist'),
  path.join(root, 'ios/Maina.xcodeproj/project.pbxproj'),
];
const fingerprint = (file) => existsSync(file)
  ? createHash('sha256').update(readFileSync(file)).digest('hex')
  : 'missing';
const canonicalBefore = generatedPaths.map((file) => [file, fingerprint(file)]);
const safeTmp = realpathSync(tmpdir());

const androidGradle = ({
  applicationId = plan.identity.androidPackage,
  versionCode = plan.release.androidVersionCode,
  versionName = plan.release.version,
} = {}) => `android {\n  defaultConfig {\n    applicationId '${applicationId}'\n    versionCode ${versionCode}\n    versionName "${versionName}"\n  }\n}\n`;
const iosInfo = ({
  version = plan.release.version,
  build = plan.release.iosBuildNumber,
} = {}) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key><string>${version}</string>\n<key>CFBundleVersion</key><string>${build}</string>\n</dict></plist>\n`;
const iosProject = ({ bundleIdentifier = plan.identity.iosBundleIdentifier, omit = false } = {}) => omit
  ? '// no product bundle identifier\n'
  : `PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier};\n`;

function safelyRemoveFixture(fixture) {
  const realFixture = realpathSync(fixture);
  const allowedPrefix = path.join(safeTmp, 'maina-generated-native-metadata-');
  if (!realFixture.startsWith(allowedPrefix)) {
    throw new Error(`Refusing fixture cleanup outside the bounded temp prefix: ${realFixture}`);
  }
  rmSync(realFixture, { recursive: true, force: true });
}

function withFixture(options, action) {
  const fixture = mkdtempSync(path.join(safeTmp, 'maina-generated-native-metadata-'));
  try {
    mkdirSync(path.join(fixture, 'android/app'), { recursive: true });
    mkdirSync(path.join(fixture, 'ios/Maina'), { recursive: true });
    mkdirSync(path.join(fixture, 'ios/Maina.xcodeproj'), { recursive: true });
    writeFileSync(path.join(fixture, 'android/app/build.gradle'), androidGradle(options.android));
    writeFileSync(path.join(fixture, 'ios/Maina/Info.plist'), iosInfo(options.ios));
    writeFileSync(path.join(fixture, 'ios/Maina.xcodeproj/project.pbxproj'), iosProject(options.project));
    action({
      androidAppBuildGradle: readFileSync(path.join(fixture, 'android/app/build.gradle'), 'utf8'),
      iosInfoPlist: readFileSync(path.join(fixture, 'ios/Maina/Info.plist'), 'utf8'),
      iosProjectPbxproj: readFileSync(path.join(fixture, 'ios/Maina.xcodeproj/project.pbxproj'), 'utf8'),
    });
  } finally {
    safelyRemoveFixture(fixture);
  }
}

function failsClosed(platform, expectedField, options) {
  withFixture(options, (files) => {
    assert.throws(
      () => validateGeneratedNativeReleaseMetadata({ platform, plan, files }),
      new RegExp(expectedField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
}

try {
  withFixture({}, (files) => {
    assert.equal(validateGeneratedNativeReleaseMetadata({ platform: 'android', plan, files }), true);
    assert.equal(validateGeneratedNativeReleaseMetadata({ platform: 'ios', plan, files }), true);
  });
  failsClosed('android', 'android.applicationId', { android: { applicationId: 'com.divay.maina.other' } });
  failsClosed('android', 'android.versionCode', { android: { versionCode: plan.release.androidVersionCode + 1 } });
  failsClosed('android', 'android.versionName', { android: { versionName: '0.10.44' } });
  failsClosed('ios', 'ios.CFBundleShortVersionString', { ios: { version: '0.10.44' } });
  failsClosed('ios', 'ios.CFBundleVersion', { ios: { build: '26' } });
  failsClosed('ios', 'ios.PRODUCT_BUNDLE_IDENTIFIER', { project: { omit: true } });
  failsClosed('ios', 'ios.PRODUCT_BUNDLE_IDENTIFIER', { project: { bundleIdentifier: 'com.divay.maina.other' } });

  const verifierSource = readFileSync(path.join(root, 'scripts/verify-generated-native-release-metadata.mjs'), 'utf8');
  assert.match(verifierSource, /const projectRoot = path\.resolve\(import\.meta\.dirname, '\.\.'\);/);
  assert.doesNotMatch(verifierSource, /process\.env|--root|MAINA_.*NATIVE/);
  console.log('Generated-native metadata synthetic pass and exact mismatch fail-closed coverage verified without canonical native writes.');
} finally {
  assert.deepEqual(generatedPaths.map((file) => [file, fingerprint(file)]), canonicalBefore);
}
