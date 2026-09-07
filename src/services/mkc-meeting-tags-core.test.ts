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

  it('requires all assignment receipt fields together in both directions', () => {
    const createReceipt = {
      ...example.remove_receipt,
      operation: 'create_definition',
      outcome: 'applied',
      tag_revision: 1,
      meeting_id: null,
      meeting_revision: null,
      assignment_revision: null,
      assignment_state: null,
    };
    expect(() => decodeMeetingTagMutationReceipt({
      ...createReceipt,
      meeting_id: example.remove_receipt.meeting_id,
    })).toThrow(/assignment field presence mismatch/);
    expect(() => decodeMeetingTagMutationReceipt({
      ...example.remove_receipt,
      assignment_revision: null,
    })).toThrow(/assignment field presence mismatch/);
  });

  it('binds applied and no-op receipts to the request revision transition', () => {
    const removeRequest = decodeMeetingTagMutationRequest(example.remove_request);
    expect(() => decodeMeetingTagMutationReceipt({
      ...example.remove_receipt,
      meeting_revision: removeRequest.operation.kind === 'remove'
        ? removeRequest.operation.expected_meeting_revision
        : 0,
      assignment_revision: removeRequest.operation.kind === 'remove'
        ? removeRequest.operation.expected_assignment_revision
        : 1,
    }, removeRequest)).toThrow(/meeting revision transition mismatch/);
    expect(() => decodeMeetingTagMutationReceipt({
      ...example.remove_receipt,
      assignment_revision: 1,
    }, removeRequest)).toThrow(/assignment revision transition mismatch/);

    expect(decodeMeetingTagMutationReceipt({
      ...example.remove_receipt,
      outcome: 'no_op',
      meeting_revision: 9,
      assignment_revision: 1,
    }, removeRequest)).toEqual(expect.objectContaining({ outcome: 'no_op' }));
    expect(() => decodeMeetingTagMutationReceipt({
      ...example.remove_receipt,
      outcome: 'no_op',
      meeting_revision: 9,
      assignment_revision: 2,
    }, removeRequest)).toThrow(/assignment revision transition mismatch/);

    const renameRequest = decodeMeetingTagMutationRequest({
      schema_version: 'mkc.meeting-tag-mutation-request.v1',
      idempotency_key: 'mobile-outbox:rename:0001',
      operation: {
        kind: 'rename_definition',
        tag_id: example.definitions[0].tag_id,
        expected_tag_revision: 2,
        display_label: 'Customer Interviews',
      },
    });
    const renameReceipt = {
      ...example.remove_receipt,
      idempotency_key: 'mobile-outbox:rename:0001',
      operation: 'rename_definition',
      outcome: 'applied',
      tag_id: example.definitions[0].tag_id,
      tag_revision: 3,
      meeting_id: null,
      meeting_revision: null,
      assignment_revision: null,
      assignment_state: null,
    };
    expect(decodeMeetingTagMutationReceipt(renameReceipt, renameRequest)).toEqual(renameReceipt);
    expect(() => decodeMeetingTagMutationReceipt({ ...renameReceipt, tag_revision: 2 }, renameRequest))
      .toThrow(/rename revision transition mismatch/);
    expect(decodeMeetingTagMutationReceipt({
      ...renameReceipt,
      outcome: 'no_op',
      tag_revision: 2,
    }, renameRequest)).toEqual(expect.objectContaining({ outcome: 'no_op' }));
  });

  it('requires first assignment and create receipts to begin at revision 1', () => {
    const assignRequest = decodeMeetingTagMutationRequest({
      schema_version: 'mkc.meeting-tag-mutation-request.v1',
      idempotency_key: 'mobile-outbox:assign:0001',
      operation: {
        kind: 'assign',
        meeting_id: example.meeting_tag_state.meeting_id,
        source_key: example.meeting_tag_state.source_key,
        tag_id: example.definitions[0].tag_id,
        expected_meeting_revision: 9,
        expected_assignment_revision: null,
      },
    });
    const assignReceipt = {
      ...example.remove_receipt,
      idempotency_key: 'mobile-outbox:assign:0001',
      operation: 'assign',
      tag_id: example.definitions[0].tag_id,
      assignment_revision: 1,
      assignment_state: 'active',
    };
    expect(decodeMeetingTagMutationReceipt(assignReceipt, assignRequest)).toEqual(assignReceipt);
    expect(() => decodeMeetingTagMutationReceipt({
      ...assignReceipt,
      outcome: 'no_op',
      meeting_revision: 9,
    }, assignRequest)).toThrow(/first assignment must apply/);

    const createRequest = decodeMeetingTagMutationRequest({
      schema_version: 'mkc.meeting-tag-mutation-request.v1',
      idempotency_key: 'mobile-outbox:create:0002',
      operation: { kind: 'create_definition', display_label: 'Pricing' },
    });
    const createReceipt = {
      ...example.remove_receipt,
      idempotency_key: 'mobile-outbox:create:0002',
      operation: 'create_definition',
      tag_revision: 1,
      meeting_id: null,
      meeting_revision: null,
      assignment_revision: null,
      assignment_state: null,
    };
    expect(decodeMeetingTagMutationReceipt(createReceipt, createRequest)).toEqual(createReceipt);
    expect(() => decodeMeetingTagMutationReceipt({ ...createReceipt, outcome: 'no_op' }, createRequest))
      .toThrow(/create must apply/);
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
