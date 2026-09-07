import type {
  MeetingTagDefinitionListV1,
  MeetingTagFilterV1,
  MeetingTagMutationReceiptV1,
  MeetingTagMutationRequestV1,
  MeetingTagStateV1,
  MkcMeetingTagContractSchema,
} from '@/contracts/mkc-meeting-tags.generated';
import { MKC_MEETING_TAG_SCHEMAS } from '@/contracts/mkc-meeting-tags.generated';

export const MKC_MEETING_TAGS_ACTIVATION = Object.freeze({
  backendMigrationQualified: false,
  backendDeploymentQualified: false,
  uiDefaultEnabled: false,
  networkMutationsEnabled: false,
});

export class MkcMeetingTagContractError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super(`Invalid meeting-tag contract field ${field}: ${reason}`);
    this.name = 'MkcMeetingTagContractError';
  }
}

function fail(path: string, reason: string): never {
  throw new MkcMeetingTagContractError(path, reason);
}

function matches(schema: MkcMeetingTagContractSchema, value: unknown, path: string): boolean {
  try {
    assertMeetingTagSchema(schema, value, path);
    return true;
  } catch (cause) {
    if (cause instanceof MkcMeetingTagContractError) return false;
    throw cause;
  }
}

function assertString(schema: MkcMeetingTagContractSchema, value: unknown, path: string): void {
  if (typeof value !== 'string') fail(path, 'expected string');
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(path, 'below minimum length');
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(path, 'above maximum length');
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) fail(path, 'pattern mismatch');
  if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) fail(path, 'expected ISO date-time');
}

function assertNumber(
  schema: MkcMeetingTagContractSchema,
  value: unknown,
  path: string,
  integer: boolean,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    fail(path, integer ? 'expected integer' : 'expected number');
  }
  if (typeof schema.minimum === 'number' && value < schema.minimum) fail(path, 'below minimum');
  if (typeof schema.maximum === 'number' && value > schema.maximum) fail(path, 'above maximum');
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(path, 'below exclusive minimum');
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(path, 'above exclusive maximum');
}

function assertArray(schema: MkcMeetingTagContractSchema, value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, 'expected array');
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(path, 'below minimum items');
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(path, 'above maximum items');
  if (schema.items && typeof schema.items === 'object') {
    value.forEach((entry, index) => (
      assertMeetingTagSchema(schema.items as MkcMeetingTagContractSchema, entry, `${path}[${index}]`)
    ));
  }
}

function assertObject(schema: MkcMeetingTagContractSchema, value: unknown, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  const object = value as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties as Record<string, MkcMeetingTagContractSchema>
    : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  for (const key of required) {
    if (!(key in object)) fail(`${path}.${key}`, 'required field is missing');
  }
  for (const [key, child] of Object.entries(object)) {
    const childSchema = properties[key];
    if (childSchema) {
      assertMeetingTagSchema(childSchema, child, `${path}.${key}`);
      continue;
    }
    if (schema.additionalProperties === false) fail(`${path}.${key}`, 'unknown field');
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      assertMeetingTagSchema(schema.additionalProperties as MkcMeetingTagContractSchema, child, `${path}.${key}`);
    }
  }
}

export function assertMeetingTagSchema(
  schema: MkcMeetingTagContractSchema,
  value: unknown,
  path = '$',
): void {
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((entry) => matches(entry as MkcMeetingTagContractSchema, value, path))) {
      fail(path, 'no accepted variant matched');
    }
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matchCount = schema.oneOf.filter((entry) => (
      matches(entry as MkcMeetingTagContractSchema, value, path)
    )).length;
    if (matchCount !== 1) fail(path, 'expected exactly one accepted variant');
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
      assertArray(schema, value, path);
      return;
    case 'object':
      assertObject(schema, value, path);
      return;
    default:
      fail(path, 'unsupported schema shape');
  }
}

function decode<T>(schema: MkcMeetingTagContractSchema, value: unknown): T {
  assertMeetingTagSchema(schema, value);
  return value as T;
}

export function compareMeetingTagCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const forbiddenTagCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function normalizeMeetingTagLabel(raw: string): { display_label: string; normalized_value: string } {
  if (forbiddenTagCharacters.test(raw)) fail('$.display_label', 'forbidden control or bidirectional character');
  const displayLabel = raw.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const scalarLength = [...displayLabel].length;
  const byteLength = new TextEncoder().encode(displayLabel).byteLength;
  if (scalarLength < 1 || scalarLength > 80 || byteLength > 240) {
    fail('$.display_label', 'must contain 1-80 Unicode scalars and at most 240 UTF-8 bytes');
  }
  return {
    display_label: displayLabel,
    normalized_value: displayLabel.toLowerCase().normalize('NFKC'),
  };
}

function assertCanonicalLabel(displayLabel: string, normalizedValue: string, path: string): void {
  const normalized = normalizeMeetingTagLabel(displayLabel);
  if (normalized.display_label !== displayLabel) fail(`${path}.display_label`, 'display label is not canonical');
  if (normalized.normalized_value !== normalizedValue) fail(`${path}.normalized_value`, 'normalized value mismatch');
}

function assertDefinitionSemantics(definition: MeetingTagDefinitionListV1['definitions'][number], path: string): void {
  assertCanonicalLabel(definition.display_label, definition.normalized_value, path);
  const createdAt = Date.parse(definition.created_at);
  const updatedAt = Date.parse(definition.updated_at);
  if (updatedAt < createdAt) fail(`${path}.updated_at`, 'precedes created_at');
  const aliases = new Set<string>();
  let priorRevision = 0;
  definition.aliases.forEach((alias, index) => {
    const aliasPath = `${path}.aliases[${index}]`;
    assertCanonicalLabel(alias.display_label, alias.normalized_value, aliasPath);
    if (aliases.has(alias.normalized_value)) fail(`${aliasPath}.normalized_value`, 'duplicate retained alias');
    if (alias.added_in_revision <= priorRevision || alias.added_in_revision > definition.revision) {
      fail(`${aliasPath}.added_in_revision`, 'aliases must use increasing valid revisions');
    }
    const addedAt = Date.parse(alias.added_at);
    if (addedAt < createdAt || addedAt > updatedAt) fail(`${aliasPath}.added_at`, 'outside definition lifetime');
    aliases.add(alias.normalized_value);
    priorRevision = alias.added_in_revision;
  });
}

export function decodeMeetingTagDefinitions(value: unknown): MeetingTagDefinitionListV1 {
  const decoded = decode<MeetingTagDefinitionListV1>(MKC_MEETING_TAG_SCHEMAS.MeetingTagDefinitionListV1, value);
  const namespace = new Map<string, string>();
  const seenTagIds = new Set<string>();
  let priorKey: string | null = null;
  decoded.definitions.forEach((definition, index) => {
    const path = `$.definitions[${index}]`;
    assertDefinitionSemantics(definition, path);
    if (seenTagIds.has(definition.tag_id)) fail(`${path}.tag_id`, 'duplicate stable tag ID');
    seenTagIds.add(definition.tag_id);
    const orderingKey = `${definition.normalized_value}\u0000${definition.tag_id}`;
    if (priorKey !== null && compareMeetingTagCodeUnits(priorKey, orderingKey) > 0) {
      fail(path, 'definitions are not in canonical order');
    }
    priorKey = orderingKey;
    for (const normalizedValue of [definition.normalized_value, ...definition.aliases.map((alias) => alias.normalized_value)]) {
      const owner = namespace.get(normalizedValue);
      if (owner && owner !== definition.tag_id) fail(path, 'label or alias belongs to another tag');
      namespace.set(normalizedValue, definition.tag_id);
    }
  });
  return decoded;
}

export function decodeMeetingTagState(value: unknown, expectedSourceKey?: string): MeetingTagStateV1 {
  const decoded = decode<MeetingTagStateV1>(MKC_MEETING_TAG_SCHEMAS.MeetingTagStateV1, value);
  if (decoded.meeting_id !== decoded.source_key) fail('$.meeting_id', 'must equal source_key');
  if (expectedSourceKey && decoded.source_key !== expectedSourceKey) fail('$.source_key', 'meeting identity mismatch');
  const activeIds = new Set<string>();
  let priorActive: { normalized_value: string; tag_id: string } | null = null;
  decoded.active.forEach((tag, index) => {
    const path = `$.active[${index}]`;
    assertCanonicalLabel(tag.display_label, tag.normalized_value, path);
    if (activeIds.has(tag.tag_id)) fail(`${path}.tag_id`, 'duplicate active tag');
    if (priorActive && (
      compareMeetingTagCodeUnits(priorActive.normalized_value, tag.normalized_value) > 0
      || (priorActive.normalized_value === tag.normalized_value
        && compareMeetingTagCodeUnits(priorActive.tag_id, tag.tag_id) > 0)
    )) fail(path, 'active tags are not in canonical order');
    activeIds.add(tag.tag_id);
    priorActive = tag;
  });
  let priorTombstoneId: string | null = null;
  const tombstoneIds = new Set<string>();
  decoded.tombstones.forEach((tag, index) => {
    const path = `$.tombstones[${index}]`;
    if (tombstoneIds.has(tag.tag_id)) fail(`${path}.tag_id`, 'duplicate tombstone');
    if (activeIds.has(tag.tag_id)) fail(`${path}.tag_id`, 'tag is both active and tombstoned');
    if (priorTombstoneId && compareMeetingTagCodeUnits(priorTombstoneId, tag.tag_id) > 0) {
      fail(path, 'tombstones are not in canonical order');
    }
    tombstoneIds.add(tag.tag_id);
    priorTombstoneId = tag.tag_id;
  });
  return decoded;
}

export function decodeMeetingTagMutationRequest(value: unknown): MeetingTagMutationRequestV1 {
  const decoded = decode<MeetingTagMutationRequestV1>(MKC_MEETING_TAG_SCHEMAS.MeetingTagMutationRequestV1, value);
  const operation = decoded.operation;
  if (operation.kind === 'create_definition' || operation.kind === 'rename_definition') {
    normalizeMeetingTagLabel(operation.display_label);
  }
  if ((operation.kind === 'assign' || operation.kind === 'remove') && operation.meeting_id !== operation.source_key) {
    fail('$.operation.meeting_id', 'must equal source_key');
  }
  return decoded;
}

export function decodeMeetingTagMutationReceipt(
  value: unknown,
  request?: MeetingTagMutationRequestV1,
): MeetingTagMutationReceiptV1 {
  const decoded = decode<MeetingTagMutationReceiptV1>(MKC_MEETING_TAG_SCHEMAS.MeetingTagMutationReceiptV1, value);
  const assignmentOperation = decoded.operation === 'assign' || decoded.operation === 'remove';
  const assignmentFields = [
    decoded.meeting_id,
    decoded.meeting_revision,
    decoded.assignment_revision,
    decoded.assignment_state,
  ];
  const everyAssignmentFieldPresent = assignmentFields.every((field) => field !== null);
  const everyAssignmentFieldAbsent = assignmentFields.every((field) => field === null);
  if (assignmentOperation ? !everyAssignmentFieldPresent : !everyAssignmentFieldAbsent) {
    fail('$.operation', 'assignment field presence mismatch');
  }
  if (decoded.operation === 'assign' && decoded.assignment_state !== 'active') fail('$.assignment_state', 'assign must be active');
  if (decoded.operation === 'remove' && decoded.assignment_state !== 'removed') fail('$.assignment_state', 'remove must be removed');
  if (request) {
    if (decoded.idempotency_key !== request.idempotency_key) fail('$.idempotency_key', 'request identity mismatch');
    if (decoded.operation !== request.operation.kind) fail('$.operation', 'request operation mismatch');
    if ('tag_id' in request.operation && decoded.tag_id !== request.operation.tag_id) fail('$.tag_id', 'request tag identity mismatch');
    if ('meeting_id' in request.operation && decoded.meeting_id !== request.operation.meeting_id) {
      fail('$.meeting_id', 'request meeting identity mismatch');
    }
    const appliedDelta = decoded.outcome === 'applied' ? 1 : 0;
    if (request.operation.kind === 'create_definition') {
      if (decoded.outcome !== 'applied' || decoded.tag_revision !== 1) {
        fail('$.tag_revision', 'create must apply at definition revision 1');
      }
    } else if (request.operation.kind === 'rename_definition') {
      if (decoded.tag_revision !== request.operation.expected_tag_revision + appliedDelta) {
        fail('$.tag_revision', 'rename revision transition mismatch');
      }
    } else {
      if (decoded.meeting_revision !== request.operation.expected_meeting_revision + appliedDelta) {
        fail('$.meeting_revision', 'meeting revision transition mismatch');
      }
      const expectedAssignmentRevision = request.operation.expected_assignment_revision;
      if (expectedAssignmentRevision === null) {
        if (decoded.outcome !== 'applied' || decoded.assignment_revision !== 1) {
          fail('$.assignment_revision', 'first assignment must apply at revision 1');
        }
      } else if (decoded.assignment_revision !== expectedAssignmentRevision + appliedDelta) {
        fail('$.assignment_revision', 'assignment revision transition mismatch');
      }
    }
  }
  return decoded;
}

export function buildMeetingTagFilter(input: {
  labels?: readonly string[];
  tagIds?: readonly string[];
  operator?: 'and' | 'or';
}): MeetingTagFilterV1 | null {
  const labels = (input.labels ?? []).filter((label) => label.trim().length > 0);
  const tagIds = (input.tagIds ?? []).filter((tagId) => tagId.trim().length > 0);
  if (labels.length + tagIds.length === 0) return null;
  if (labels.length + tagIds.length > 20) fail('$.refs', 'more than 20 nonempty clauses');
  const refs = new Map<string, MeetingTagFilterV1['refs'][number]>();
  for (const tagId of tagIds) {
    const key = `0:${tagId}`;
    if (!refs.has(key)) refs.set(key, { kind: 'tag_id', tag_id: tagId });
  }
  for (const label of labels) {
    const normalized = normalizeMeetingTagLabel(label);
    const key = `1:${normalized.normalized_value}`;
    if (!refs.has(key)) refs.set(key, { kind: 'label', ...normalized });
  }
  const filter = {
    schema_version: 'mkc.meeting-tag-filter.v1' as const,
    operator: input.operator ?? 'and',
    refs: [...refs.entries()]
      .sort(([left], [right]) => compareMeetingTagCodeUnits(left, right))
      .map(([, reference]) => reference),
  };
  return decode<MeetingTagFilterV1>(MKC_MEETING_TAG_SCHEMAS.MeetingTagFilterV1, filter);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareMeetingTagCodeUnits(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeMeetingTagMutationRequest(
  value: unknown,
): MeetingTagMutationRequestV1 {
  const request = decodeMeetingTagMutationRequest(value);
  if (request.operation.kind !== 'create_definition' && request.operation.kind !== 'rename_definition') {
    return request;
  }
  return {
    ...request,
    operation: {
      ...request.operation,
      display_label: normalizeMeetingTagLabel(request.operation.display_label).display_label,
    },
  } as MeetingTagMutationRequestV1;
}

export function canonicalMeetingTagMutationRequestJson(value: unknown): string {
  return stable(canonicalizeMeetingTagMutationRequest(value));
}

export function meetingTagMutationSubjectKey(value: unknown): string {
  const operation = canonicalizeMeetingTagMutationRequest(value).operation;
  return operation.kind === 'create_definition'
    ? stable(['definition_label', normalizeMeetingTagLabel(operation.display_label).normalized_value])
    : operation.kind === 'rename_definition'
      ? stable(['definition', operation.tag_id])
      : stable(['assignment', operation.meeting_id, operation.tag_id]);
}

export function canonicalMeetingTagDefinitionsJson(value: unknown): string {
  return stable(decodeMeetingTagDefinitions(value));
}

export function canonicalMeetingTagStateJson(value: unknown, expectedSourceKey?: string): string {
  return stable(decodeMeetingTagState(value, expectedSourceKey));
}

export function canonicalMeetingTagMutationReceiptJson(
  value: unknown,
  request?: MeetingTagMutationRequestV1,
): string {
  return stable(decodeMeetingTagMutationReceipt(value, request));
}

export function assertMeetingTagIdempotentReplay(
  firstValue: unknown,
  retryValue: unknown,
): MeetingTagMutationRequestV1 {
  const first = canonicalizeMeetingTagMutationRequest(firstValue);
  const retry = decodeMeetingTagMutationRequest(retryValue);
  if (first.idempotency_key !== retry.idempotency_key) fail('$.idempotency_key', 'retry key mismatch');
  if (stable(first.operation) !== stable(canonicalizeMeetingTagMutationRequest(retry).operation)) {
    fail('$.operation', 'same idempotency key changed request body');
  }
  return retry;
}
