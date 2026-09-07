#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_ROOT = [
  process.env.MAINA_BACKEND_ROOT,
  resolve(APP_ROOT, '..', 'maina-knowledge-cloud'),
].filter(Boolean).find((candidate) => existsSync(resolve(candidate, '.git')));
const COORDINATION_ROOT = resolve(APP_ROOT, 'coordination');
const BACKEND_COMMIT = '0faf14d6b089d2e386cca6649c2f1dc5792bc7ac';
const ACCEPTANCE_COMMIT = 'a8184f6f1baef08bb0eae2865c8467c035a6c0db';
const ACCEPTANCE_PATH = 'operations/receipts/p4-05-accepted.json';
const ACCEPTANCE_SHA256 = 'e427216f3d06c52c5d343c15d234aab4d35b14e7ed48eb0c6c1e49f08aa3a7c4';
const SNAPSHOT_ROOT = resolve(APP_ROOT, 'contracts', 'mkc-meeting-tags');
const GENERATED_FILE = resolve(APP_ROOT, 'src', 'contracts', 'mkc-meeting-tags.generated.ts');
const CHECK_ONLY = process.argv.includes('--check');

const SOURCE_FILES = Object.freeze({
  contract: 'contracts/meeting-tags.v1.md',
  example: 'contracts/examples/maina-meeting-tags.v1.json',
  openapi: 'contracts/openapi.v0.1.json',
  validator: 'src/meetings/tag-contract.ts',
  service: 'src/meetings/tag-service.ts',
  migration: 'migrations/0025_canonical_meeting_tags.sql',
});
const EXPECTED_SOURCE_SHA256 = Object.freeze({
  contract: '7a526d5f5e79ec50d0fcdb30a20a280aa23216283b8f96eff44ffca71b000310',
  example: '3ebbfdf92457f1253397ac27e266a7c44094956edd0ac92e940400f60419d2e2',
  openapi: '584b1669d71135c4651e87f669c460187b2c7595033d5733ad3843623b921d10',
  validator: 'cee0f011307462fcca12364b0917fd43962f22d04a3c3b70281ada12425764c0',
  service: '10c856a0ef851022d31a056de43c0ce845437b9ae89fda472ad1b29ee9e4ca15',
  migration: '934ab6decfa78524beceb5573a3629794d62fb79bf68b62dc9e5a43918e539e3',
});
const SCHEMA_NAMES = Object.freeze([
  'MeetingTagDefinitionV1',
  'MeetingTagAssignmentV1',
  'MeetingTagStateV1',
  'MeetingTagMutationRequestV1',
  'MeetingTagMutationReceiptV1',
  'MeetingTagFilterV1',
  'ResolvedMeetingTagFilterV1',
  'MeetingTagSafeAuditEventV1',
  'MeetingTagDefinitionListV1',
]);
const PATH_CONTRACTS = Object.freeze({
  '/v1/meeting-tags': Object.freeze({ method: 'get', response: 'MeetingTagDefinitionListV1' }),
  '/v1/meeting-tags/mutations': Object.freeze({
    method: 'post', request: 'MeetingTagMutationRequestV1', response: 'MeetingTagMutationReceiptV1',
  }),
  '/v1/meetings/{sourceKey}/tags': Object.freeze({ method: 'get', response: 'MeetingTagStateV1' }),
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCommitted(root, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 24 * 1024 * 1024,
  });
}

function readBackend(path) {
  if (!BACKEND_ROOT) {
    throw new Error('Canonical Maina Knowledge Cloud checkout was not found. Set MAINA_BACKEND_ROOT.');
  }
  return readCommitted(BACKEND_ROOT, BACKEND_COMMIT, path);
}

function verifySources(sources) {
  for (const [name, expected] of Object.entries(EXPECTED_SOURCE_SHA256)) {
    const actual = sha256(sources[name]);
    if (actual !== expected) throw new Error(`Pinned meeting-tag ${name} hash changed: ${actual}`);
  }
  const acceptance = readCommitted(COORDINATION_ROOT, ACCEPTANCE_COMMIT, ACCEPTANCE_PATH);
  if (sha256(acceptance) !== ACCEPTANCE_SHA256) throw new Error('P4-05 acceptance receipt hash changed.');
  const receipt = JSON.parse(acceptance);
  if (receipt.state !== 'ACCEPTED' || receipt.resultRevision !== `github.com/divayhere/maina-knowledge-cloud@${BACKEND_COMMIT}`) {
    throw new Error('P4-05 acceptance receipt does not bind the expected Backend source.');
  }
}

function exactRef(operation, location, expectedName) {
  const schema = location === 'request'
    ? operation.requestBody?.content?.['application/json']?.schema
    : operation.responses?.['200']?.content?.['application/json']?.schema;
  const expected = `#/components/schemas/${expectedName}`;
  if (schema?.$ref !== expected || Object.keys(schema).length !== 1) {
    throw new Error(`Meeting-tag ${location} schema is not exact ${expected}.`);
  }
}

function selectOpenApi(openapi) {
  if (openapi.openapi !== '3.1.0') throw new Error('Meeting-tag OpenAPI must remain 3.1.0.');
  const paths = {};
  for (const [path, contract] of Object.entries(PATH_CONTRACTS)) {
    const pathItem = openapi.paths?.[path];
    const operation = pathItem?.[contract.method];
    if (!pathItem || !operation) throw new Error(`Missing ${contract.method.toUpperCase()} ${path}.`);
    if (contract.request) exactRef(operation, 'request', contract.request);
    exactRef(operation, 'response', contract.response);
    paths[path] = pathItem;
  }
  const schemas = {};
  for (const name of SCHEMA_NAMES) {
    const schema = openapi.components?.schemas?.[name];
    if (!schema || typeof schema !== 'object') throw new Error(`Missing meeting-tag schema ${name}.`);
    if (JSON.stringify(schema).includes('"$ref"')) throw new Error(`Meeting-tag schema ${name} must be self-contained.`);
    schemas[name] = schema;
  }
  return { openapi: openapi.openapi, paths, schemas };
}

function literal(value) {
  return JSON.stringify(value);
}

function propertyName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function schemaToType(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if ('$ref' in schema) throw new Error(`Unexpected generated meeting-tag schema reference ${schema.$ref}.`);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ') || 'never';
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((entry) => schemaToType(entry, depth)).join(' | ');
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => schemaToType(entry, depth)).join(' | ');
  if (schema.type === 'null') return 'null';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return `Array<${schemaToType(schema.items, depth + 1)}>`;
  if (schema.type !== 'object') return 'unknown';
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const indent = '  '.repeat(depth);
  const childIndent = '  '.repeat(depth + 1);
  const lines = Object.entries(properties).map(([key, value]) => (
    `${childIndent}${propertyName(key)}${required.has(key) ? '' : '?'}: ${schemaToType(value, depth + 1)};`
  ));
  if (schema.additionalProperties && schema.additionalProperties !== false) {
    const valueType = schema.additionalProperties === true ? 'unknown' : schemaToType(schema.additionalProperties, depth + 1);
    lines.push(`${childIndent}[key: string]: ${valueType};`);
  }
  return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('\n')}\n${indent}}`;
}

function buildGenerated(selected) {
  const types = SCHEMA_NAMES.map((name) => `export type ${name} = ${schemaToType(selected.schemas[name])};`).join('\n\n');
  return `/* eslint-disable @typescript-eslint/array-type */\n`
    + `// Generated from Maina Knowledge Cloud ${BACKEND_COMMIT}. Do not edit by hand.\n`
    + `// Run: npm run import:mkc-meeting-tags\n\n`
    + `export type MkcMeetingTagContractSchema = Record<string, unknown>;\n\n`
    + `${types}\n\n`
    + `export const MKC_MEETING_TAG_SCHEMAS: Readonly<Record<${SCHEMA_NAMES.map(literal).join(' | ')}, MkcMeetingTagContractSchema>> = ${JSON.stringify(selected.schemas, null, 2)};\n`;
}

function buildManifest(sources, selected, selectedText, generated) {
  return `${JSON.stringify({
    schema_version: 'maina.mobile-meeting-tags-contract-pin.v1',
    backend_commit: BACKEND_COMMIT,
    backend_source_acceptance: {
      coordination_commit: ACCEPTANCE_COMMIT,
      receipt_path: ACCEPTANCE_PATH,
      receipt_sha256: ACCEPTANCE_SHA256,
      scope: 'source-only-not-deployed',
    },
    source_files: Object.fromEntries(Object.entries(SOURCE_FILES).map(([name, path]) => [
      name, { path, sha256: sha256(sources[name]) },
    ])),
    selected_openapi: {
      path: 'contracts/mkc-meeting-tags/openapi.selected.json',
      sha256: sha256(selectedText),
      paths: Object.keys(PATH_CONTRACTS),
      schemas: Object.keys(selected.schemas),
    },
    generated_types: {
      path: 'src/contracts/mkc-meeting-tags.generated.ts',
      sha256: sha256(generated),
    },
    activation: {
      mobile_meeting_tags: 'default-off',
      backend_migration_0025: 'not-executed',
      backend_deployment: 'not-deployed',
      ui: 'not-activated',
      network_mutations: 'not-activated',
    },
  }, null, 2)}\n`;
}

function loadPinnedInputs() {
  const sources = Object.fromEntries(Object.entries(SOURCE_FILES).map(([name, path]) => [name, readBackend(path)]));
  verifySources(sources);
  const example = JSON.parse(sources.example);
  if (!example.meeting_tag_state || !example.remove_request || !example.remove_receipt) {
    throw new Error('Pinned meeting-tag example is missing required conformance surfaces.');
  }
  const selected = selectOpenApi(JSON.parse(sources.openapi));
  const selectedText = `${JSON.stringify(selected, null, 2)}\n`;
  const generated = buildGenerated(selected);
  return { sources, selected, selectedText, generated };
}

const { sources, selected, selectedText, generated } = loadPinnedInputs();
const manifest = buildManifest(sources, selected, selectedText, generated);

if (CHECK_ONLY) {
  const expected = {
    'meeting-tags.v1.md': sources.contract,
    'maina-meeting-tags.v1.json': sources.example,
    'openapi.selected.json': selectedText,
    'manifest.json': manifest,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (readFileSync(resolve(SNAPSHOT_ROOT, name), 'utf8') !== value) {
      throw new Error(`Committed meeting-tag snapshot ${name} does not match the accepted Backend pin.`);
    }
  }
  if (readFileSync(GENERATED_FILE, 'utf8') !== generated) {
    throw new Error('Generated meeting-tag types do not match the accepted Backend pin.');
  }
  process.stdout.write(`MKC meeting-tag contract pin verified at ${BACKEND_COMMIT}.\n`);
  process.exit(0);
}

mkdirSync(SNAPSHOT_ROOT, { recursive: true });
mkdirSync(dirname(GENERATED_FILE), { recursive: true });
writeFileSync(resolve(SNAPSHOT_ROOT, 'meeting-tags.v1.md'), sources.contract);
writeFileSync(resolve(SNAPSHOT_ROOT, 'maina-meeting-tags.v1.json'), sources.example);
writeFileSync(resolve(SNAPSHOT_ROOT, 'openapi.selected.json'), selectedText);
writeFileSync(resolve(SNAPSHOT_ROOT, 'manifest.json'), manifest);
writeFileSync(GENERATED_FILE, generated);
process.stdout.write(`Pinned MKC meeting-tag contracts from ${BACKEND_COMMIT}.\n`);
