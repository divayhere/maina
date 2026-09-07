import { describe, expect, it } from 'vitest';

import example from '../../contracts/mkc-meeting-tags/maina-meeting-tags.v1.json';
import {
  MKC_MEETING_TAGS_ACTIVATION,
  assertMeetingTagIdempotentReplay,
  buildMeetingTagFilter,
  decodeMeetingTagDefinitions,
  decodeMeetingTagMutationReceipt,
  decodeMeetingTagMutationRequest,
  decodeMeetingTagState,
  normalizeMeetingTagLabel,
} from './mkc-meeting-tags-core';

const definitionList = {
  schema_version: 'mkc.meeting-tag-definitions.v1',
  definitions: example.definitions,
};

describe('MKC manual meeting-tag contract boundary', () => {
  it('strictly decodes the accepted definition, meeting state, mutation, and receipt examples', () => {
    expect(decodeMeetingTagDefinitions(definitionList)).toEqual(definitionList);
    expect(decodeMeetingTagState(example.meeting_tag_state, example.meeting_tag_state.source_key))
      .toEqual(example.meeting_tag_state);
    const request = decodeMeetingTagMutationRequest(example.remove_request);
    expect(decodeMeetingTagMutationReceipt(example.remove_receipt, request)).toEqual(example.remove_receipt);
  });

  it('rejects unknown/private response fields and malformed stable IDs', () => {
    expect(() => decodeMeetingTagState({
      ...example.meeting_tag_state,
      active: [{ ...example.meeting_tag_state.active[0], transcript_text: 'must not survive' }],
    })).toThrow(/unknown field/);
    expect(() => decodeMeetingTagDefinitions({
      ...definitionList,
      definitions: [{ ...example.definitions[0], tag_id: 'tag_short' }],
    })).toThrow(/pattern mismatch/);
  });

  it('rejects cross-meeting identity, active/tombstone overlap, and noncanonical ordering', () => {
    expect(() => decodeMeetingTagState({
      ...example.meeting_tag_state,
      meeting_id: 'meeting:foreign',
    })).toThrow(/must equal source_key/);
    expect(() => decodeMeetingTagState({
      ...example.meeting_tag_state,
      tombstones: [{
        ...example.meeting_tag_state.tombstones[0],
        tag_id: example.meeting_tag_state.active[0].tag_id,
      }],
    })).toThrow(/both active and tombstoned/);
    expect(() => decodeMeetingTagDefinitions({
      ...definitionList,
      definitions: [...example.definitions].reverse(),
    })).toThrow(/canonical order/);
  });

  it('rejects two canonically ordered definitions that reuse one stable tag ID', () => {
    expect(() => decodeMeetingTagDefinitions({
      ...definitionList,
      definitions: [
        example.definitions[0],
        { ...example.definitions[1], tag_id: example.definitions[0].tag_id },
      ],
    })).toThrow(/duplicate stable tag ID/);
  });

  it('normalizes exact labels and builds a deduplicated AND-by-default filter', () => {
    expect(normalizeMeetingTagLabel('  Customer\tResearch  ')).toEqual({
      display_label: 'Customer Research',
      normalized_value: 'customer research',
    });
    expect(buildMeetingTagFilter({
      labels: [' Dubai ', 'Ｄｕｂａｉ', ''],
      tagIds: ['tag_01k4customerdiscovery000001'],
    })).toEqual({
      schema_version: 'mkc.meeting-tag-filter.v1',
      operator: 'and',
      refs: [
        { kind: 'tag_id', tag_id: 'tag_01k4customerdiscovery000001' },
        { kind: 'label', display_label: 'Dubai', normalized_value: 'dubai' },
      ],
    });
  });

  it('matches Backend first-wins behavior for mixed-case and NFKC-equivalent labels', () => {
    expect(buildMeetingTagFilter({ labels: ['Dubai', 'DUBAI'] })?.refs).toEqual([
      { kind: 'label', display_label: 'Dubai', normalized_value: 'dubai' },
    ]);
    expect(buildMeetingTagFilter({ labels: ['ＤＵＢＡＩ', 'Dubai'] })?.refs).toEqual([
      { kind: 'label', display_label: 'DUBAI', normalized_value: 'dubai' },
    ]);
  });

  it('fails closed for invalid filter cardinality, IDs, and bidi controls', () => {
    expect(() => buildMeetingTagFilter({ labels: Array.from({ length: 21 }, (_, index) => `Tag ${index}`) }))
      .toThrow(/20 nonempty clauses/);
    expect(() => buildMeetingTagFilter({ tagIds: ['tag_invalid'] })).toThrow(/accepted variant/);
    expect(() => normalizeMeetingTagLabel('Finance\u202eReview')).toThrow(/bidirectional/);
  });

  it('accepts same-key canonical replay and rejects a changed body', () => {
    const first = {
      schema_version: 'mkc.meeting-tag-mutation-request.v1',
      idempotency_key: 'mobile-outbox:create:0001',
      operation: { kind: 'create_definition', display_label: 'Customer  Research' },
    };
    const same = {
      ...first,
      operation: { ...first.operation, display_label: ' Customer Research ' },
    };
    expect(assertMeetingTagIdempotentReplay(first, same)).toEqual(same);
    expect(() => assertMeetingTagIdempotentReplay(first, {
      ...same,
      operation: { ...same.operation, display_label: 'Pricing' },
    })).toThrow(/changed request body/);
  });

  it('keeps migration, deployment, UI, and network mutation activation off', () => {
    expect(MKC_MEETING_TAGS_ACTIVATION).toEqual({
      backendMigrationQualified: false,
      backendDeploymentQualified: false,
      uiDefaultEnabled: false,
      networkMutationsEnabled: false,
    });
  });
});
