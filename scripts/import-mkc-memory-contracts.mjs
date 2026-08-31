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
const BACKEND_COMMIT = 'b879876506aaf7a18f4c2d26b9c5442629f68190';
const OPENAPI_PATH = 'contracts/openapi.v0.1.json';
const IDENTITY_PATH = 'src/auth/identity.ts';
const OPENAPI_SHA256 = '9b413bc44317f657dfc358927c53320a7be3b64cc7517a6e55fb89d5f38c8697';
const IDENTITY_SHA256 = '22290021bb398e59770eed6952e3f37ba8954afd3d455e99c6189c2d9339681a';
const SNAPSHOT_ROOT = resolve(APP_ROOT, 'contracts', 'mkc-memory-releases');
const SNAPSHOT_FILE = resolve(SNAPSHOT_ROOT, 'openapi.selected.json');
const MANIFEST_FILE = resolve(SNAPSHOT_ROOT, 'manifest.json');
const GENERATED_FILE = resolve(APP_ROOT, 'src', 'contracts', 'mkc-memory-releases.generated.ts');
const CHECK_ONLY = process.argv.includes('--check');

const CONTRACTS = {
  memoryPulse: {
    path: '/v1/memory-pulse', method: 'get', status: '200', typeName: 'MemoryPulseV1',
  },
  memoryPulseViewed: {
    path: '/v1/memory-pulse/viewed', method: 'post', status: '200', typeName: 'MemoryPulseViewedV1',
  },
  smartRecallList: {
    path: '/v1/smart-recalls', method: 'get', status: '200', typeName: 'SmartRecallListV1',
  },
  smartRecallDetail: {
    path: '/v1/smart-recalls/{smartRecallId}', method: 'get', status: '200', typeName: 'SmartRecallDefinitionV1',
  },
  smartRecallRun: {
    path: '/v1/smart-recalls/{smartRecallId}/run', method: 'post', status: '201', typeName: 'SmartRecallRunV1',
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCommitted(path) {
  if (!BACKEND_ROOT) {
    throw new Error('Canonical Maina backend checkout was not found. Set MAINA_BACKEND_ROOT to import the Memory contracts.');
  }
  return execFileSync('git', ['show', `${BACKEND_COMMIT}:${path}`], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function responseSchema(openapi, contract) {
  const schema = openapi.paths?.[contract.path]?.[contract.method]?.responses?.[contract.status]
    ?.content?.['application/json']?.schema;
  if (!schema || typeof schema !== 'object') {
    throw new Error(`Missing ${contract.method.toUpperCase()} ${contract.path} ${contract.status} response schema.`);
  }
  return schema;
}

function selectSchemas(openapi) {
  return Object.fromEntries(Object.entries(CONTRACTS).map(([key, contract]) => [
    key,
    responseSchema(openapi, contract),
  ]));
}

function literal(value) {
  return JSON.stringify(value);
}

function propertyName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function schemaToType(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if ('$ref' in schema) throw new Error(`Selected Memory schema unexpectedly contains $ref: ${schema.$ref}`);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ') || 'never';
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((entry) => schemaToType(entry, depth)).join(' | ');
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((entry) => schemaToType(entry, depth)).join(' | ');
  if (Array.isArray(schema.allOf)) return schema.allOf.map((entry) => schemaToType(entry, depth)).join(' & ');

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
  if (lines.length === 0) return 'Record<string, never>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}

function buildGenerated(selected) {
  const types = Object.entries(CONTRACTS).map(([key, contract]) => (
    `export type ${contract.typeName} = ${schemaToType(selected[key])};`
  )).join('\n\n');
  return `/* eslint-disable @typescript-eslint/array-type */\n`
    + `// Generated from Maina Knowledge Cloud ${BACKEND_COMMIT}. Do not edit by hand.\n`
    + `// Run: npm run import:mkc-memory-contracts\n\n`
    + `export type MkcMemoryContractSchema = Record<string, unknown>;\n\n`
    + `${types}\n\n`
    + `export const MKC_MEMORY_CONTRACT_SCHEMAS: Readonly<Record<${Object.keys(CONTRACTS).map(literal).join(' | ')}, MkcMemoryContractSchema>> = ${JSON.stringify(selected, null, 2)};\n`;
}

function buildManifest(selected, generated) {
  return `${JSON.stringify({
    schema_version: 'maina.mobile-memory-contract-pin.v1',
    backend_commit: BACKEND_COMMIT,
    deployment: 'c6b5f0ce-5631-48bf-a83b-c76a2f6c99d0',
    rollback: 'f2a16cdf-902d-4ae8-99a3-135385a6a15c',
    coordination: 'dea5f017065c0717e05c4b459c1c29b994d20995',
    source_files: {
      openapi: { path: OPENAPI_PATH, sha256: OPENAPI_SHA256 },
      mobile_session_scopes: { path: IDENTITY_PATH, sha256: IDENTITY_SHA256 },
    },
    selected_schemas_sha256: sha256(`${JSON.stringify(selected, null, 2)}\n`),
    generated_types: {
      path: 'src/contracts/mkc-memory-releases.generated.ts',
      sha256: sha256(generated),
    },
    activation: {
      memory_surface: 'default-off',
      memory_pulse: 'contract-complete-deployed-default-off',
      saved_smart_recalls: 'contract-complete-deployed-default-off',
      mobile_scope: 'new-sessions-recall-read-existing-sessions-repair-required',
    },
  }, null, 2)}\n`;
}

function validateSemanticBoundary(openapi, identitySource, selected) {
  if (sha256(`${JSON.stringify(openapi, null, 2)}\n`) !== OPENAPI_SHA256 && sha256(readCommitted(OPENAPI_PATH)) !== OPENAPI_SHA256) {
    throw new Error(`MKC OpenAPI does not match ${BACKEND_COMMIT}.`);
  }
  if (sha256(identitySource) !== IDENTITY_SHA256) {
    throw new Error(`MKC mobile session source does not match ${BACKEND_COMMIT}.`);
  }
  const mobileScopeBlock = identitySource.slice(
    identitySource.indexOf('const MAINA_MOBILE_SCOPES'),
    identitySource.indexOf('] as const;', identitySource.indexOf('const MAINA_MOBILE_SCOPES')) + '] as const;'.length,
  );
  if (!mobileScopeBlock.includes('"recall:read"')) {
    throw new Error('Pinned mobile session does not grant recall:read.');
  }
  if (selected.memoryPulse.properties?.schema_version?.const !== 'mkc.memory-pulse.v1') {
    throw new Error('Memory Pulse schema version is not stable.');
  }
  if (selected.smartRecallList.properties?.schema_version?.const !== 'mkc.smart-recall-list.v1') {
    throw new Error('Smart Recall list schema version is not stable.');
  }
  if (selected.smartRecallRun.properties?.schema_version?.const !== 'mkc.smart-recall-run.v1') {
    throw new Error('Smart Recall run schema version is not stable.');
  }
  const prepare = responseSchema(openapi, {
    path: '/v1/smart-recalls/{smartRecallId}/prepare', method: 'post', status: '201',
  });
  if (JSON.stringify(prepare) !== JSON.stringify(selected.smartRecallRun)) {
    throw new Error('Smart Recall prepare response no longer matches the run contract.');
  }
}

function loadPinnedInputs() {
  const openapiSource = readCommitted(OPENAPI_PATH);
  const identitySource = readCommitted(IDENTITY_PATH);
  if (sha256(openapiSource) !== OPENAPI_SHA256) throw new Error('Pinned MKC OpenAPI hash changed.');
  const openapi = JSON.parse(openapiSource);
  const selected = selectSchemas(openapi);
  validateSemanticBoundary(openapi, identitySource, selected);
  return { selected, generated: buildGenerated(selected) };
}

if (CHECK_ONLY) {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
  const { selected, generated } = loadPinnedInputs();
  if (JSON.stringify(snapshot) !== JSON.stringify(selected)) {
    throw new Error('Committed MKC Memory schema snapshot does not match the accepted Backend pin.');
  }
  if (readFileSync(GENERATED_FILE, 'utf8') !== generated) {
    throw new Error('Generated MKC Memory types do not match the accepted Backend pin.');
  }
  if (readFileSync(MANIFEST_FILE, 'utf8') !== buildManifest(selected, generated)) {
    throw new Error('MKC Memory contract manifest does not match the accepted Backend pin.');
  }
  process.stdout.write(`MKC Memory contract pin verified at ${BACKEND_COMMIT}.\n`);
  process.exit(0);
}

const { selected, generated } = loadPinnedInputs();
mkdirSync(SNAPSHOT_ROOT, { recursive: true });
mkdirSync(dirname(GENERATED_FILE), { recursive: true });
writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(selected, null, 2)}\n`);
writeFileSync(GENERATED_FILE, generated);
writeFileSync(MANIFEST_FILE, buildManifest(selected, generated));
process.stdout.write(`Pinned MKC Memory contracts from ${BACKEND_COMMIT}.\n`);
