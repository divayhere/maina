#!/usr/bin/env node

import { lstatSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256File,
  validateApprovedRelease,
  validateReleaseProvenance,
} from './lib/release-provenance-core.mjs';

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function closedAuthorizationEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ownerAuthorization: object is required');
  const expected = [
    'schemaVersion', 'authorizationId', 'authorizedBy', 'sourceThreadId', 'directive',
    'directiveSha256', 'releaseId', 'planSha256', 'candidateProvenanceSha256',
    'artifactSha256', 'scope', 'issuedAt', 'nonce',
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error('ownerAuthorization: contains missing or unknown fields');
  }
  return value;
}

export function generateOwnerApprovedProvenance({ planPath, candidatePath, authorizationPath, outputPath }) {
  for (const [name, file] of Object.entries({ planPath, candidatePath, authorizationPath, outputPath })) {
    if (!path.isAbsolute(file)) throw new Error(`${name}: absolute path is required`);
  }
  const authorizationStat = lstatSync(authorizationPath);
  if (!authorizationStat.isFile() || authorizationStat.isSymbolicLink()) {
    throw new Error('authorizationPath: regular non-symlink file is required');
  }
  if ((authorizationStat.mode & 0o777) !== 0o600) throw new Error('authorizationPath: mode 0600 is required');

  const plan = json(planPath);
  const candidate = json(candidatePath);
  const authorization = closedAuthorizationEnvelope(json(authorizationPath));
  validateReleaseProvenance(candidate, plan, { requireBoth: true });
  if (candidate.approval.status !== 'candidate' || candidate.approval.approvedBy !== null || candidate.approval.approvedAt !== null) {
    throw new Error('candidate approval must remain candidate/null/null');
  }

  const approved = structuredClone(candidate);
  approved.approval = {
    status: 'admin-approved',
    approvedBy: authorization.authorizedBy,
    approvedAt: authorization.issuedAt,
    authorization: {
      path: authorizationPath,
      sha256: sha256File(authorizationPath),
      bytes: statSync(authorizationPath).size,
      authorizationId: authorization.authorizationId,
      directiveSha256: authorization.directiveSha256,
      planSha256: authorization.planSha256,
      candidateProvenanceSha256: authorization.candidateProvenanceSha256,
      androidArtifactSha256: authorization.artifactSha256?.android,
      iosArtifactSha256: authorization.artifactSha256?.ios,
      scope: authorization.scope,
      nonce: authorization.nonce,
      issuedAt: authorization.issuedAt,
    },
  };
  validateApprovedRelease(approved, plan, { planSha256: sha256File(planPath) });

  const descriptor = openSync(outputPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(approved, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  validateApprovedRelease(json(outputPath), plan, { planSha256: sha256File(planPath) });
  return approved;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  if (process.argv.length !== 6) {
    console.error('Usage: generate-owner-approved-provenance.mjs PLAN.json CANDIDATE.json OWNER-AUTHORIZATION.json OUTPUT.json');
    process.exit(2);
  }
  generateOwnerApprovedProvenance({
    planPath: path.resolve(process.argv[2]),
    candidatePath: path.resolve(process.argv[3]),
    authorizationPath: path.resolve(process.argv[4]),
    outputPath: path.resolve(process.argv[5]),
  });
  console.log('Owner-authorized release provenance generated from an external immutable authorization envelope.');
}
