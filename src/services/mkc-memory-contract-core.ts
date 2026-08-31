import type {
  MemoryPulseV1,
  MemoryPulseViewedV1,
  MkcMemoryContractSchema,
  SmartRecallDefinitionV1,
  SmartRecallListV1,
  SmartRecallRunV1,
} from '@/contracts/mkc-memory-releases.generated';
import { MKC_MEMORY_CONTRACT_SCHEMAS } from '@/contracts/mkc-memory-releases.generated';

export class MkcMemoryContractError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`Invalid Memory contract field ${field}: ${reason}`);
    this.name = 'MkcMemoryContractError';
  }
}

function fail(path: string, reason: string): never {
  throw new MkcMemoryContractError(path, reason);
}

function matches(schema: MkcMemoryContractSchema, value: unknown, path: string): boolean {
  try {
    assertSchema(schema, value, path);
    return true;
  } catch (cause) {
    if (cause instanceof MkcMemoryContractError) return false;
    throw cause;
  }
}

function assertString(schema: MkcMemoryContractSchema, value: unknown, path: string): void {
  if (typeof value !== 'string') fail(path, 'expected string');
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail(path, 'pattern mismatch');
  if (typeof schema.format === 'string' && schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) {
    fail(path, 'expected ISO date-time');
  }
}

function assertNumber(schema: MkcMemoryContractSchema, value: unknown, path: string, integer: boolean): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    fail(path, integer ? 'expected integer' : 'expected number');
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) fail(path, 'below minimum');
  if (typeof schema.maximum === 'number' && value > schema.maximum) fail(path, 'above maximum');
}

function assertObject(schema: MkcMemoryContractSchema, value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  const object = value as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, MkcMemoryContractSchema>
    : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  for (const key of required) {
    if (!(key in object)) fail(`${path}.${key}`, 'required field is missing');
  }
  for (const [key, child] of Object.entries(object)) {
    const propertySchema = properties[key];
    if (propertySchema) {
      assertSchema(propertySchema, child, `${path}.${key}`);
      continue;
    }
    if (schema.additionalProperties === false) fail(`${path}.${key}`, 'unknown field');
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      assertSchema(schema.additionalProperties as MkcMemoryContractSchema, child, `${path}.${key}`);
    }
  }
}

export function assertSchema(schema: MkcMemoryContractSchema, value: unknown, path = '$'): void {
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((entry) => matches(entry as MkcMemoryContractSchema, value, path))) fail(path, 'no accepted variant matched');
    return;
  }
  if ('const' in schema && !Object.is(value, schema.const)) fail(path, `expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) fail(path, 'enum mismatch');

  switch (schema.type) {
    case 'null':
      if (value !== null) fail(path, 'expected null');
      return;
    case 'string':
      assertString(schema, value, path);
      return;
    case 'number':
      assertNumber(schema, value, path, false);
      return;
    case 'integer':
      assertNumber(schema, value, path, true);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'expected boolean');
      return;
    case 'array':
      if (!Array.isArray(value)) fail(path, 'expected array');
      if (schema.items && typeof schema.items === 'object') {
        value.forEach((entry, index) => assertSchema(schema.items as MkcMemoryContractSchema, entry, `${path}[${index}]`));
      }
      return;
    case 'object':
      assertObject(schema, value, path);
      return;
    default:
      fail(path, 'unsupported schema shape');
  }
}

function decode<T>(schema: MkcMemoryContractSchema, value: unknown): T {
  assertSchema(schema, value);
  return value as T;
}

export function decodeMemoryPulse(value: unknown): MemoryPulseV1 {
  return decode<MemoryPulseV1>(MKC_MEMORY_CONTRACT_SCHEMAS.memoryPulse, value);
}

export function decodeMemoryPulseViewed(value: unknown): MemoryPulseViewedV1 {
  return decode<MemoryPulseViewedV1>(MKC_MEMORY_CONTRACT_SCHEMAS.memoryPulseViewed, value);
}

export function decodeSmartRecallList(value: unknown): SmartRecallListV1 {
  return decode<SmartRecallListV1>(MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallList, value);
}

export function decodeSmartRecallDefinition(value: unknown, expectedId?: string): SmartRecallDefinitionV1 {
  const decoded = decode<SmartRecallDefinitionV1>(MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallDetail, value);
  if (expectedId && decoded.id !== expectedId) fail('$.id', 'saved Recall identity mismatch');
  return decoded;
}

export function decodeSmartRecallRun(value: unknown, expectedId?: string): SmartRecallRunV1 {
  const decoded = decode<SmartRecallRunV1>(MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallRun, value);
  if (expectedId && decoded.smart_recall.id !== expectedId) fail('$.smart_recall.id', 'saved Recall identity mismatch');
  if (decoded.smart_recall.last_search_id !== decoded.run.search_id) fail('$.run.search_id', 'frozen search identity mismatch');
  if (decoded.smart_recall.last_result_sha256 !== decoded.run.result_sha256) fail('$.run.result_sha256', 'result checksum mismatch');
  if (decoded.smart_recall.last_bundle_sha256 !== decoded.run.bundle_sha256) fail('$.run.bundle_sha256', 'bundle checksum mismatch');
  return decoded;
}

export function smartRecallDeltaCount(delta: SmartRecallDefinitionV1['last_delta']): number | null {
  if (!delta || !delta.comparable_to_previous) return null;
  return delta.new_sources.length
    + delta.removed_sources.length
    + delta.revised_sources.length
    + delta.new_facts.length
    + delta.removed_facts.length
    + delta.changed_decisions.length
    + delta.new_corrections.length
    + delta.actions_opened.length
    + delta.actions_completed.length
    + delta.actions_cancelled.length
    + delta.new_questions.length;
}

export function memoryPulseCoverageLabel(pulse: MemoryPulseV1): string {
  const coverage = pulse.commitments.coverage;
  if (coverage.warnings.length > 0) return 'Coverage limits shown';
  if (coverage.indexed_action_count === 0) return 'No indexed actions yet';
  return `${coverage.indexed_action_count} indexed action${coverage.indexed_action_count === 1 ? '' : 's'}`;
}
