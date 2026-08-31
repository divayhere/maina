import type {
  MemoryPulseV1,
  MkcMemoryContractSchema,
  SmartRecallDefinitionV1,
  SmartRecallListV1,
  SmartRecallRunV1,
} from '@/contracts/mkc-memory-releases.generated';
import { MKC_MEMORY_CONTRACT_SCHEMAS } from '@/contracts/mkc-memory-releases.generated';

function stringFixture(schema: MkcMemoryContractSchema): string {
  if (schema.format === 'date-time') return '2026-08-31T00:00:00Z';
  if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return '2026-08-31';
  if (schema.pattern === '^[a-f0-9]{64}$') return 'a'.repeat(64);
  return 'fixture';
}

export function buildMkcMemorySchemaFixture(schema: MkcMemoryContractSchema): unknown {
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return buildMkcMemorySchemaFixture(schema.anyOf[0] as MkcMemoryContractSchema);
  switch (schema.type) {
    case 'null': return null;
    case 'string': return stringFixture(schema);
    case 'number':
    case 'integer': return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': {
      const properties = schema.properties as Record<string, MkcMemoryContractSchema> | undefined;
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      return Object.fromEntries(Object.entries(properties ?? {})
        .filter(([key]) => required.has(key))
        .map(([key, child]) => [key, buildMkcMemorySchemaFixture(child)]));
    }
    default: throw new Error('Unsupported fixture schema.');
  }
}

export const memoryPulseFixture = buildMkcMemorySchemaFixture(
  MKC_MEMORY_CONTRACT_SCHEMAS.memoryPulse,
) as MemoryPulseV1;

export const smartRecallListFixture = buildMkcMemorySchemaFixture(
  MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallList,
) as SmartRecallListV1;

export const smartRecallDefinitionFixture = {
  ...(buildMkcMemorySchemaFixture(MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallDetail) as SmartRecallDefinitionV1),
  id: 'smart-recall-1',
  name: 'Client preparation',
  original_query: 'What changed for this client?',
};

const generatedRunFixture = buildMkcMemorySchemaFixture(
  MKC_MEMORY_CONTRACT_SCHEMAS.smartRecallRun,
) as SmartRecallRunV1;

export const smartRecallRunFixture: SmartRecallRunV1 = {
  ...generatedRunFixture,
  smart_recall: {
    ...generatedRunFixture.smart_recall,
    id: smartRecallDefinitionFixture.id,
    name: smartRecallDefinitionFixture.name,
    original_query: smartRecallDefinitionFixture.original_query,
    last_search_id: 'search-1',
    last_result_sha256: 'b'.repeat(64),
    last_bundle_sha256: 'c'.repeat(64),
  },
  run: {
    ...generatedRunFixture.run,
    search_id: 'search-1',
    result_sha256: 'b'.repeat(64),
    bundle_sha256: 'c'.repeat(64),
  },
  frozen_recall: {
    ...generatedRunFixture.frozen_recall,
    search_id: 'search-1',
    result_sha256: 'b'.repeat(64),
    bundle_sha256: 'c'.repeat(64),
  },
};
