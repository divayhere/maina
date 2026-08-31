#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import {
  authorizeExactArtifact,
  qualifyExactArtifact,
  replayConfig,
  validateApprovedRelease,
  validateReleaseProvenance,
} from './lib/release-provenance-core.mjs';

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const [command, ...args] = process.argv.slice(2);
if (command === 'validate' && args.length === 2) {
  validateApprovedRelease(json(args[1]), json(args[0]));
  console.log('Admin-approved dual-platform release provenance, structure, and pins verified.');
} else if (command === 'qualify' && args.length === 5) {
  const [platform, planPath, provenancePath, artifactPath, buildLogPath] = args;
  qualifyExactArtifact({
    platform,
    plan: json(planPath),
    provenance: json(provenancePath),
    artifactPath,
    buildLogPath,
  });
  console.log(`Exact ${platform} artifact hash, bytes, audit evidence, and build log qualified.`);
} else if (command === 'authorize' && args.length === 4) {
  const [platform, planPath, provenancePath, artifactPath] = args;
  authorizeExactArtifact({
    platform,
    plan: json(planPath),
    provenance: json(provenancePath),
    artifactPath,
  });
  console.log(`Admin-approved dual-platform provenance authorizes this exact ${platform} artifact.`);
} else if (command === 'replay-config' && args.length === 2) {
  const config = replayConfig(json(args[1]), json(args[0]));
  console.log([
    config.androidPackage,
    config.androidVersion,
    config.androidVersionCode,
    config.iosBundleIdentifier,
    config.iosVersion,
    config.iosBuildNumber,
  ].join('\t'));
} else {
  console.error('Usage:');
  console.error('  release-provenance-cli.mjs validate PLAN.json PROVENANCE.json');
  console.error('  release-provenance-cli.mjs qualify <android|ios> PLAN.json PROVENANCE.json ARTIFACT BUILD.log');
  console.error('  release-provenance-cli.mjs authorize <android|ios> PLAN.json PROVENANCE.json ARTIFACT');
  console.error('  release-provenance-cli.mjs replay-config PLAN.json PROVENANCE.json');
  process.exit(2);
}
