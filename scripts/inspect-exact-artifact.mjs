#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [platform, planPath, artifactArgument, symbolsArgument] = process.argv.slice(2);
if (!['android', 'ios'].includes(platform) || !planPath || !artifactArgument) {
  throw new Error('Usage: inspect-exact-artifact.mjs android PLAN.json APK | ios PLAN.json APP.zip APP.dSYM.zip');
}
if (platform === 'ios' && !symbolsArgument) throw new Error('iOS inspection requires the separate dSYM ZIP.');
const artifactPath = realpathSync(artifactArgument);
const symbolsPath = symbolsArgument ? realpathSync(symbolsArgument) : null;
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const equalJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const artifact = { path: artifactPath, sha256: sha(readFileSync(artifactPath)), bytes: statSync(artifactPath).size };
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

function zipEntries(zip) {
  return run('/usr/bin/unzip', ['-Z1', zip]).split('\n').filter((entry) => entry && !entry.endsWith('/')).sort();
}

function zipEntry(zip, entry) {
  return execFileSync('/usr/bin/unzip', ['-p', zip, entry], { maxBuffer: 512 * 1024 * 1024 });
}

function zipManifest(zip, entries) {
  return sha(entries.map((entry) => {
    const contents = zipEntry(zip, entry);
    return `${sha(contents)} ${contents.length} ${entry}`;
  }).join('\n'));
}

function androidInspection() {
  const androidHome = process.env.ANDROID_HOME ?? process.env.MAINA_ANDROID_HOME;
  if (!androidHome) throw new Error('ANDROID_HOME or MAINA_ANDROID_HOME is required.');
  const buildToolsRoot = path.join(androidHome, 'build-tools');
  const buildToolsVersion = readdirSync(buildToolsRoot).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const aapt2 = path.join(buildToolsRoot, buildToolsVersion, 'aapt2');
  const apksigner = path.join(buildToolsRoot, buildToolsVersion, 'apksigner');
  const badging = run(aapt2, ['dump', 'badging', artifactPath]);
  const permissionsOutput = run(aapt2, ['dump', 'permissions', artifactPath]);
  const manifest = run(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', artifactPath]);
  const signer = run(apksigner, ['verify', '--verbose', '--print-certs', artifactPath]);
  const identity = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  if (!identity) throw new Error('aapt2 did not return Android package identity.');
  const permissions = [...permissionsOutput.matchAll(/uses-permission(?:-sdk-[0-9]+)?: name='([^']+)'/g)]
    .map((match) => match[1]).sort();
  const components = [];
  let current = null;
  for (const line of manifest.split('\n')) {
    const element = line.match(/^(\s*)E: (activity|activity-alias|service|receiver|provider)\b/);
    if (element) {
      current = { depth: element[1].length, type: element[2], name: null, exported: null, permission: null, process: null };
      components.push(current);
      continue;
    }
    if (!current) continue;
    const depth = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (/^\s*E: /.test(line) && depth <= current.depth) {
      current = null;
      continue;
    }
    const attribute = (name) => {
      if (!line.includes(`:${name}(`)) return null;
      const raw = line.match(/\(Raw: "([^"]*)"\)/)?.[1];
      if (raw !== undefined) return raw;
      const compiled = line.match(/\)=([^\s]+)/)?.[1];
      if (compiled === 'true' || compiled === 'false') return compiled;
      return compiled ?? null;
    };
    current.name ??= attribute('name');
    current.exported ??= attribute('exported');
    current.permission ??= attribute('permission');
    current.process ??= attribute('process');
  }
  for (const component of components) delete component.depth;
  components.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
  const entries = zipEntries(artifactPath);
  const abis = [...new Set(entries.flatMap((entry) => entry.match(/^lib\/([^/]+)\//)?.[1] ?? []))].sort();
  const entryByBasename = new Map(entries.map((entry) => [path.basename(entry), entry]));
  const jniLibraries = {};
  for (const library of ['libonnxruntime.so', 'libsherpa-onnx-jni.so']) {
    const entry = entryByBasename.get(library);
    if (!entry) throw new Error(`Required JNI library is missing: ${library}`);
    jniLibraries[library] = sha(zipEntry(artifactPath, entry));
  }
  const vad = entries.find((entry) => entry.endsWith('/silero_vad.int8.onnx'));
  if (!vad) throw new Error('Silero VAD model is missing.');
  const modelEntries = entries.filter((entry) => /(?:\.onnx|\/tokens\.txt)$/i.test(entry));
  const modelChecksums = Object.fromEntries(modelEntries.map((entry) => [entry, sha(zipEntry(artifactPath, entry))]));
  const signerSha = signer.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i)?.[1]?.toLowerCase();
  if (!signerSha) throw new Error('apksigner did not return the release certificate digest.');
  const expectedPolicy = plan.artifactPolicy.android;
  const permissionsExact = equalJson(permissions, expectedPolicy.permissions);
  const componentsExact = equalJson(components, expectedPolicy.components);
  return {
    packageName: identity[1],
    versionName: identity[3],
    versionCode: Number(identity[2]),
    releaseSigned: /Verifies\s*$/m.test(signer) || signer.length > 0,
    signerCertificateSha256: signerSha,
    debuggable: /android:debuggable[^\n]*(?:Raw: "true"|0xffffffff)/.test(manifest),
    profileable: /E: profileable\b/.test(manifest),
    permissionsExact,
    componentsExact,
    exportedBoundariesExact: componentsExact,
    permissions,
    components,
    abis,
    jniLibraries,
    vadModelSha256: sha(zipEntry(artifactPath, vad)),
    modelChecksums,
    contentsManifestSha256: zipManifest(artifactPath, entries),
    inspectionTools: { aapt2: buildToolsVersion, apksigner: buildToolsVersion, unzip: 'system' },
  };
}

function walk(root) {
  const result = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isSymbolicLink()) result.push({ relative, contents: Buffer.from(`symlink:${readlinkSync(absolute)}`) });
      else result.push({ relative, contents: readFileSync(absolute) });
    }
  };
  visit(root);
  return result;
}

function treeManifest(root) {
  return sha(walk(root).map(({ relative, contents }) => `${sha(contents)} ${contents.length} ${relative}`).join('\n'));
}

function findDirectory(root, suffix) {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const name of readdirSync(current)) {
      const child = path.join(current, name);
      if (!lstatSync(child).isDirectory()) continue;
      if (name.endsWith(suffix)) return child;
      queue.push(child);
    }
  }
  return null;
}

function iosInspection() {
  const temporary = mkdtempSync(path.join(tmpdir(), 'maina-ios-inspection-'));
  try {
    const appRoot = path.join(temporary, 'app');
    const dsymRoot = path.join(temporary, 'dsym');
    run('/bin/mkdir', ['-p', appRoot, dsymRoot]);
    run('/usr/bin/ditto', ['-x', '-k', artifactPath, appRoot]);
    run('/usr/bin/ditto', ['-x', '-k', symbolsPath, dsymRoot]);
    const app = findDirectory(appRoot, '.app');
    const dsym = findDirectory(dsymRoot, '.dSYM');
    if (!app) throw new Error('Installable iOS app ZIP does not contain a .app.');
    if (!dsym) throw new Error('Separate iOS dSYM ZIP does not contain a .dSYM.');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const info = path.join(app, 'Info.plist');
    const plist = (file, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]).trim();
    const executableName = plist(info, 'CFBundleExecutable');
    const executable = path.join(app, executableName);
    const architectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/).sort();
    const requirementResult = spawnSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8' });
    if (requirementResult.status !== 0) throw new Error(requirementResult.stderr || 'codesign requirement extraction failed');
    const designatedRequirement = `${requirementResult.stdout}\n${requirementResult.stderr}`.match(/designated => (.+)/)?.[1]?.trim();
    if (!designatedRequirement) throw new Error('Designated requirement is missing.');
    const entitlementsPlist = path.join(temporary, 'entitlements.plist');
    const entitlementsResult = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', app], { encoding: 'utf8' });
    if (entitlementsResult.status !== 0) throw new Error(entitlementsResult.stderr || 'codesign entitlement extraction failed');
    writeFileSync(entitlementsPlist, entitlementsResult.stdout);
    const entitlementsJson = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', entitlementsPlist]);
    const entitlements = JSON.parse(entitlementsJson);
    const profilePlist = path.join(temporary, 'profile.plist');
    writeFileSync(profilePlist, execFileSync('/usr/bin/security', ['cms', '-D', '-i', path.join(app, 'embedded.mobileprovision')]));
    const profileEntitlements = JSON.parse(run('/usr/bin/plutil', ['-extract', 'Entitlements', 'json', '-o', '-', profilePlist]));
    const profileUuid = run('/usr/bin/plutil', ['-extract', 'UUID', 'raw', profilePlist]).trim();
    const profileName = run('/usr/bin/plutil', ['-extract', 'Name', 'raw', profilePlist]).trim();
    const profileExpiry = run('/usr/bin/plutil', ['-extract', 'ExpirationDate', 'raw', profilePlist]).trim();
    const appUuid = run('/usr/bin/dwarfdump', ['--uuid', executable]).match(/UUID: ([0-9A-F-]+)/)?.[1];
    const dsymExecutable = path.join(dsym, 'Contents/Resources/DWARF', executableName);
    const dsymUuid = run('/usr/bin/dwarfdump', ['--uuid', dsymExecutable]).match(/UUID: ([0-9A-F-]+)/)?.[1];
    if (!appUuid || !dsymUuid) throw new Error('App or dSYM UUID is missing.');
    const expiresAt = new Date(profileExpiry).toISOString();
    const minimumExpiry = Date.now() + plan.toolchains.ios.minimumProfileWindowHours * 60 * 60 * 1000;
    const appManifest = treeManifest(app);
    const appEntitlementsExact = equalJson(entitlements, plan.artifactPolicy.ios.appEntitlements);
    const profileEntitlementsExact = equalJson(profileEntitlements, plan.artifactPolicy.ios.profileEntitlements);
    return {
      bundleIdentifier: plist(info, 'CFBundleIdentifier'),
      version: plist(info, 'CFBundleShortVersionString'),
      buildNumber: plist(info, 'CFBundleVersion'),
      architectures,
      signatureValid: true,
      teamId: entitlements['com.apple.developer.team-identifier'],
      designatedRequirement,
      entitlementsExact: appEntitlementsExact && profileEntitlementsExact,
      entitlementsSha256: sha(Buffer.from(entitlementsJson)),
      entitlements,
      profileEntitlements,
      profile: {
        uuid: profileUuid,
        name: profileName,
        teamId: profileEntitlements['com.apple.developer.team-identifier'],
        expiresAt,
        sufficientWindow: Date.parse(expiresAt) > minimumExpiry,
      },
      appUuid,
      dsymUuid,
      appContentsManifestSha256: appManifest,
      appBundleSha256: appManifest,
      inspectionTools: { codesign: 'system', security: 'system', dwarfdump: 'system', ditto: 'system' },
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const audit = platform === 'android' ? androidInspection() : iosInspection();
process.stdout.write(`${JSON.stringify({
  schemaVersion: 'maina.exact-artifact-inspection.v1',
  platform,
  artifact,
  ...(platform === 'ios' ? {
    debugSymbols: {
      path: symbolsPath,
      sha256: sha(readFileSync(symbolsPath)),
      bytes: statSync(symbolsPath).size,
    },
  } : {}),
  audit,
}, null, 2)}\n`);
