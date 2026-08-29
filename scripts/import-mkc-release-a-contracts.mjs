#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_ROOT = [
  process.env.MAINA_BACKEND_ROOT,
  resolve(APP_ROOT, '..', 'Maina', 'code', 'backend'),
  resolve(APP_ROOT, '..', '..', 'Maina', 'code', 'backend'),
].filter(Boolean).find((candidate) => existsSync(resolve(candidate, '.git')));
const RELEASE_COMMIT = '57cbb52';
const SNAPSHOT_ROOT = resolve(APP_ROOT, 'contracts', 'mkc-release-a');
const GENERATED_FILE = resolve(APP_ROOT, 'src', 'contracts', 'mkc-release-a.generated.ts');
const CHECK_ONLY = process.argv.includes('--check');

const SOURCE_FILES = {
  openapi: 'contracts/openapi.v0.1.json',
  apiTypes: 'src/contracts/types.ts',
  retrievalTypes: 'src/retrieval/contracts.ts',
  recallIntent: 'src/retrieval/intent.ts',
  handoff: 'docs/RELEASE_A_CONTRACT_HANDOFF_2026-08-29.md',
};
const EXPECTED_SOURCE_SHA256 = {
  openapi: '003ade465b3bc84465b50a548d8b9b83309adfb40e256f9a4d3a162795e7df4d',
  apiTypes: '310d2bedde38f0994598c188d343c4e2760b3d91b4d38e777f1926b5662483a8',
  retrievalTypes: 'f614bce4dede9ecc54681caca3861ea0e2e0112ffbb0653dbb4971f76bb3ca8e',
  recallIntent: '9a12932253a81fa171620c26136e52267ed4335f79f95f057574a7848888524c',
  handoff: 'ad1695be2c1f7a527ce58c477f60106b67049d87d015b1bbde16ad8ec6b380dc',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCommitted(path) {
  if (!BACKEND_ROOT) {
    throw new Error('Canonical Maina backend checkout was not found. Set MAINA_BACKEND_ROOT to import a new contract pin.');
  }
  return execFileSync('git', ['show', `${RELEASE_COMMIT}:${path}`], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
}

function verifySourceHashes(sources) {
  for (const [key, expected] of Object.entries(EXPECTED_SOURCE_SHA256)) {
    const actual = sha256(sources[key]);
    if (actual !== expected) {
      throw new Error(`MKC Release A source ${key} does not match ${RELEASE_COMMIT}: ${actual}`);
    }
  }
}

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Could not extract contract block: ${start}`);
  return source.slice(startIndex, endIndex).trimEnd();
}

function buildGeneratedTypes(sources) {
  const meetings = sliceBetween(
    sources.apiTypes,
    'export type MeetingReadiness',
    '\nexport type TopicItem',
  ).replaceAll('import("../retrieval/contracts").', '');
  const retrievalPrelude = sliceBetween(
    sources.retrievalTypes,
    'export const RECALL_SEARCH_REQUEST_VERSION',
    '\nexport type FrozenSearchResultV1',
  );
  const frozenOpen = sources.retrievalTypes.slice(
    sources.retrievalTypes.indexOf('export type FrozenRecallOpenV1'),
  ).trim();
  const recallIntent = sources.recallIntent.match(/export type RecallIntent = [^;]+;/)?.[0];
  if (!recallIntent || !frozenOpen) throw new Error('Could not extract Recall contract types.');

  return `/* eslint-disable @typescript-eslint/array-type */\n` +
    `// Generated from Maina Knowledge Cloud ${RELEASE_COMMIT}. Do not edit by hand.\n` +
    `// Run: npm run import:mkc-release-a\n\n` +
    `${recallIntent}\n\n${retrievalPrelude}\n\n${frozenOpen}\n\n${meetings}\n`;
}

function loadSnapshots() {
  return {
    openapi: readFileSync(resolve(SNAPSHOT_ROOT, 'openapi.v0.1.json'), 'utf8'),
    apiTypes: readFileSync(resolve(SNAPSHOT_ROOT, 'types.ts.source'), 'utf8'),
    retrievalTypes: readFileSync(resolve(SNAPSHOT_ROOT, 'retrieval-contracts.ts.source'), 'utf8'),
    recallIntent: readFileSync(resolve(SNAPSHOT_ROOT, 'intent.ts.source'), 'utf8'),
    handoff: readFileSync(resolve(SNAPSHOT_ROOT, 'RELEASE_A_CONTRACT_HANDOFF_2026-08-29.md'), 'utf8'),
  };
}

function manifestFor(sources, generated) {
  return `${JSON.stringify({
    schema_version: 'maina.mobile-contract-pin.v1',
    backend_commit: RELEASE_COMMIT,
    source_files: Object.fromEntries(Object.entries(SOURCE_FILES).map(([key, path]) => [
      key,
      { path, sha256: sha256(sources[key]) },
    ])),
    generated_types: {
      path: 'src/contracts/mkc-release-a.generated.ts',
      sha256: sha256(generated),
    },
    activation: {
      meetings: 'contract-complete-default-off',
      frozen_open: 'contract-complete-default-off-deployment-pending',
      frozen_chapter: 'contract-complete-default-off-deployment-pending',
      frozen_source: 'contract-complete-default-off-deployment-pending',
    },
  }, null, 2)}\n`;
}

if (CHECK_ONLY) {
  const sources = loadSnapshots();
  verifySourceHashes(sources);
  const generated = buildGeneratedTypes(sources);
  const expectedManifest = manifestFor(sources, generated);
  if (readFileSync(GENERATED_FILE, 'utf8') !== generated) {
    throw new Error('Generated MKC Release A types do not match pinned source snapshots.');
  }
  if (readFileSync(resolve(SNAPSHOT_ROOT, 'manifest.json'), 'utf8') !== expectedManifest) {
    throw new Error('MKC Release A contract manifest does not match pinned source snapshots.');
  }
  const openapi = JSON.parse(sources.openapi);
  const expectedRefs = {
    '/v1/meetings': 'mkc.meeting-library.v1',
    '/v1/meetings/{sourceKey}': 'mkc.meeting-detail.v1',
    '/v1/meetings/{sourceKey}/transcript': 'mkc.meeting-transcript-page.v1',
  };
  for (const [path, schemaVersion] of Object.entries(expectedRefs)) {
    const schema = openapi.paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
    if (schema?.properties?.schema_version?.const !== schemaVersion) {
      throw new Error(`MKC Release A path ${path} is not pinned to ${schemaVersion}.`);
    }
  }
  const frozenSchemas = {
    '/v1/recall/searches/{searchId}/open': 'mkc.frozen-recall-open.v1',
    '/v1/recall/searches/{searchId}/bundle/chapters/{chapterId}': 'mkc.frozen-recall-chapter.v1',
    '/v1/recall/searches/{searchId}/sources/{sourceKey}': 'mkc.frozen-recall-source.v1',
  };
  for (const [path, schemaVersion] of Object.entries(frozenSchemas)) {
    const schema = openapi.paths?.[path]?.get?.responses?.['200']?.content?.['application/json']?.schema;
    if (schema?.properties?.schema_version?.const !== schemaVersion) {
      throw new Error(`MKC Release A frozen contract ${path} is not pinned to ${schemaVersion}.`);
    }
  }
  process.stdout.write(`MKC Release A contract pin verified at ${RELEASE_COMMIT}.\n`);
  process.exit(0);
}

const sources = Object.fromEntries(
  Object.entries(SOURCE_FILES).map(([key, path]) => [key, readCommitted(path)]),
);
verifySourceHashes(sources);
const generated = buildGeneratedTypes(sources);
mkdirSync(SNAPSHOT_ROOT, { recursive: true });
mkdirSync(dirname(GENERATED_FILE), { recursive: true });
writeFileSync(resolve(SNAPSHOT_ROOT, 'openapi.v0.1.json'), sources.openapi);
writeFileSync(resolve(SNAPSHOT_ROOT, 'types.ts.source'), sources.apiTypes);
writeFileSync(resolve(SNAPSHOT_ROOT, 'retrieval-contracts.ts.source'), sources.retrievalTypes);
  writeFileSync(resolve(SNAPSHOT_ROOT, 'intent.ts.source'), sources.recallIntent);
writeFileSync(resolve(SNAPSHOT_ROOT, 'RELEASE_A_CONTRACT_HANDOFF_2026-08-29.md'), sources.handoff);
writeFileSync(GENERATED_FILE, generated);
writeFileSync(resolve(SNAPSHOT_ROOT, 'manifest.json'), manifestFor(sources, generated));
process.stdout.write(`Pinned MKC Release A contracts from ${RELEASE_COMMIT}.\n`);
