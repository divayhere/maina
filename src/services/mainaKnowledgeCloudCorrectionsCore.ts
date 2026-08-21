import type { MainaKnowledgeCloudSourcePackage } from './mainaKnowledgeCloudCore';

export const MAINA_PACKET_CORRECTION_FIELDS = [
  'title',
  'content.summary',
  'content.decisions',
  'content.todos',
  'content.open_questions',
] as const;

export type MainaPacketCorrectionField = typeof MAINA_PACKET_CORRECTION_FIELDS[number];

export type MainaKnowledgeCloudCorrectionPackage = {
  schema_version: 'mkc.correction.v1';
  correction_key: string;
  source_key: string;
  correction_type: 'note';
  field_path: MainaPacketCorrectionField;
  body: string;
  author: 'maina-app';
  occurred_at: string;
  supersedes_correction_key?: string;
  version_tag: string;
  provenance: {
    origin: 'maina-android';
    author: 'maina-app';
    author_model?: string;
    captured_at: string;
    client_schema_version: 'maina.sync.v1';
  };
  metadata: {
    derivation: 'meeting-packet-regeneration';
    provider_id?: string;
    model?: string;
    field_version: number;
  };
};

export type MeetingPacketCorrectionValues = {
  title: string;
  summary: string;
  decisions: string[];
  todos: string[];
  openQuestions: string[];
};

export type CorrectionFieldSnapshot = {
  fieldPath: MainaPacketCorrectionField;
  valueFingerprint: string;
  body: string;
};

const MAX_BODY_CHARS = 5_000;

function normalizedText(value: unknown): string {
  return String(value ?? '').trim().replace(/\r\n/g, '\n');
}

function normalizedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizedText).filter(Boolean).slice(0, 50);
}

function listBody(label: string, values: string[]): string {
  const full = values.length > 0
    ? `Current regenerated ${label}:\n${values.map((value) => `- ${value}`).join('\n')}`
    : `Current regenerated ${label}: none.`;
  return full.slice(0, MAX_BODY_CHARS);
}

function summaryBody(summary: string): string {
  return `Current regenerated summary:\n${summary || 'No summary was extracted.'}`.slice(0, MAX_BODY_CHARS);
}

function fingerprint(value: string | string[]): string {
  return JSON.stringify(value);
}

export function packetCorrectionSnapshots(
  packet: MeetingPacketCorrectionValues,
): CorrectionFieldSnapshot[] {
  const title = normalizedText(packet.title);
  const summary = normalizedText(packet.summary);
  const decisions = normalizedList(packet.decisions);
  const todos = normalizedList(packet.todos);
  const openQuestions = normalizedList(packet.openQuestions);
  return [
    {
      fieldPath: 'title',
      valueFingerprint: fingerprint(title),
      body: `Current regenerated meeting title:\n${title || 'Meeting'}`.slice(0, MAX_BODY_CHARS),
    },
    {
      fieldPath: 'content.summary',
      valueFingerprint: fingerprint(summary),
      body: summaryBody(summary),
    },
    {
      fieldPath: 'content.decisions',
      valueFingerprint: fingerprint(decisions),
      body: listBody('decisions', decisions),
    },
    {
      fieldPath: 'content.todos',
      valueFingerprint: fingerprint(todos),
      body: listBody('to-dos', todos),
    },
    {
      fieldPath: 'content.open_questions',
      valueFingerprint: fingerprint(openQuestions),
      body: listBody('open questions', openQuestions),
    },
  ];
}

export function sourceFieldFingerprint(
  sourcePayloadJson: string,
  fieldPath: MainaPacketCorrectionField,
): { fingerprint: string; hasBaselineValue: boolean } | null {
  try {
    const source = JSON.parse(sourcePayloadJson) as MainaKnowledgeCloudSourcePackage;
    if (source.schema_version !== 'mkc.source.v1') return null;
    switch (fieldPath) {
      case 'title':
        return {
          fingerprint: fingerprint(normalizedText(source.title)),
          hasBaselineValue: true,
        };
      case 'content.summary': {
        const hasBaselineValue = Object.prototype.hasOwnProperty.call(source.content, 'summary');
        return {
          fingerprint: fingerprint(normalizedText(source.content.summary)),
          hasBaselineValue,
        };
      }
      case 'content.decisions': {
        const hasBaselineValue = Object.prototype.hasOwnProperty.call(source.content, 'decisions');
        return {
          fingerprint: fingerprint(normalizedList(source.content.decisions)),
          hasBaselineValue,
        };
      }
      case 'content.todos': {
        const hasBaselineValue = Object.prototype.hasOwnProperty.call(source.content, 'todos');
        return {
          fingerprint: fingerprint(normalizedList(source.content.todos)),
          hasBaselineValue,
        };
      }
      case 'content.open_questions': {
        const hasBaselineValue = Object.prototype.hasOwnProperty.call(source.content, 'open_questions');
        return {
          fingerprint: fingerprint(normalizedList(source.content.open_questions)),
          hasBaselineValue,
        };
      }
    }
  } catch {
    return null;
  }
}

function fieldKey(fieldPath: MainaPacketCorrectionField): string {
  return fieldPath.replace(/^content\./, '').replace(/_/g, '-');
}

export function buildMainaKnowledgeCloudCorrectionPackage(input: {
  meetingId: string;
  sourceKey: string;
  fieldPath: MainaPacketCorrectionField;
  body: string;
  versionNumber: number;
  supersedesCorrectionKey?: string | null;
  occurredAt: number;
  providerId?: string | null;
  model?: string | null;
}): MainaKnowledgeCloudCorrectionPackage {
  const versionTag = `${fieldKey(input.fieldPath)}.v${input.versionNumber}`;
  return {
    schema_version: 'mkc.correction.v1',
    correction_key: `correction:maina:${input.meetingId}:${fieldKey(input.fieldPath)}:v${input.versionNumber}`,
    source_key: input.sourceKey,
    correction_type: 'note',
    field_path: input.fieldPath,
    body: input.body.slice(0, MAX_BODY_CHARS),
    author: 'maina-app',
    occurred_at: new Date(input.occurredAt).toISOString(),
    ...(input.supersedesCorrectionKey
      ? { supersedes_correction_key: input.supersedesCorrectionKey }
      : {}),
    version_tag: versionTag,
    provenance: {
      origin: 'maina-android',
      author: 'maina-app',
      ...(input.model ? { author_model: input.model.slice(0, 200) } : {}),
      captured_at: new Date(input.occurredAt).toISOString(),
      client_schema_version: 'maina.sync.v1',
    },
    metadata: {
      derivation: 'meeting-packet-regeneration',
      ...(input.providerId ? { provider_id: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      field_version: input.versionNumber,
    },
  };
}
