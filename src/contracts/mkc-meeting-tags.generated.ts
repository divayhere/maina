/* eslint-disable @typescript-eslint/array-type */
// Generated from Maina Knowledge Cloud 0faf14d6b089d2e386cca6649c2f1dc5792bc7ac. Do not edit by hand.
// Run: npm run import:mkc-meeting-tags

export type MkcMeetingTagContractSchema = Record<string, unknown>;

export type MeetingTagDefinitionV1 = {
  display_label: string;
  normalized_value: string;
  schema_version: "mkc.meeting-tag-definition.v1";
  tag_id: string;
  visibility: "owner_private";
  revision: number;
  aliases: Array<{
      display_label: string;
      normalized_value: string;
      added_in_revision: number;
      added_at: string;
    }>;
  created_at: string;
  updated_at: string;
};

export type MeetingTagAssignmentV1 = {
  schema_version: "mkc.meeting-tag-assignment.v1";
  assignment_id: string;
  meeting_id: string;
  source_key: string;
  tag_id: string;
  revision: number;
  state: "active" | "removed";
  assigned_at: string;
  updated_at: string;
  removed_at: string | null;
};

export type MeetingTagStateV1 = {
  schema_version: "mkc.meeting-tag-state.v1";
  meeting_id: string;
  source_key: string;
  meeting_revision: number;
  active: Array<{
      tag_id: string;
      display_label: string;
      assignment_revision: number;
      assigned_at: string;
      removed_at: null;
      normalized_value: string;
      definition_revision: number;
      assignment_id: string;
    }>;
  tombstones: Array<{
      tag_id: string;
      assignment_id: string;
      assignment_revision: number;
      removed_at: string;
    }>;
};

export type MeetingTagMutationRequestV1 = {
  schema_version: "mkc.meeting-tag-mutation-request.v1";
  idempotency_key: string;
  operation: {
    kind: "create_definition";
    display_label: string;
  } | {
    kind: "rename_definition";
    tag_id: string;
    expected_tag_revision: number;
    display_label: string;
  } | {
    kind: "assign";
    meeting_id: string;
    source_key: string;
    tag_id: string;
    expected_meeting_revision: number;
    expected_assignment_revision: number | null;
  } | {
    kind: "remove";
    meeting_id: string;
    source_key: string;
    tag_id: string;
    expected_meeting_revision: number;
    expected_assignment_revision: number;
  };
};

export type MeetingTagMutationReceiptV1 = {
  schema_version: "mkc.meeting-tag-mutation-receipt.v1";
  idempotency_key: string;
  replayed: boolean;
  operation: "create_definition" | "rename_definition" | "assign" | "remove";
  outcome: "applied" | "no_op";
  tag_id: string;
  meeting_id: string | null;
  tag_revision: number;
  meeting_revision: number | null;
  assignment_revision: number | null;
  assignment_state: "active" | "removed" | null;
  occurred_at: string;
};

export type MeetingTagFilterV1 = {
  schema_version: "mkc.meeting-tag-filter.v1";
  operator: "and" | "or";
  refs: Array<{
      kind: "tag_id";
      tag_id: string;
    } | {
      kind: "label";
      display_label: string;
      normalized_value: string;
    }>;
};

export type ResolvedMeetingTagFilterV1 = {
  schema_version: "mkc.meeting-tag-filter-resolution.v1";
  operator: "and" | "or";
  requested_clause_count: number;
  resolved_tag_ids: Array<string>;
  unresolved_refs: Array<{
      kind: "tag_id";
      tag_id: string;
    } | {
      kind: "label";
      display_label: string;
      normalized_value: string;
    }>;
  match_semantics: "exact_active_assignments_only";
};

export type MeetingTagSafeAuditEventV1 = {
  schema_version: "mkc.meeting-tag-audit.v1";
  operation: "create_definition" | "rename_definition" | "assign" | "remove" | "filter";
  outcome: "applied" | "replayed" | "no_op" | "rejected" | "conflict";
  requested_tag_count: number;
  resolved_tag_count: number;
  revision_conflict: boolean;
  occurred_at: string;
};

export type MeetingTagDefinitionListV1 = {
  schema_version: "mkc.meeting-tag-definitions.v1";
  definitions: Array<{
      display_label: string;
      normalized_value: string;
      schema_version: "mkc.meeting-tag-definition.v1";
      tag_id: string;
      visibility: "owner_private";
      revision: number;
      aliases: Array<{
          display_label: string;
          normalized_value: string;
          added_in_revision: number;
          added_at: string;
        }>;
      created_at: string;
      updated_at: string;
    }>;
};

export const MKC_MEETING_TAG_SCHEMAS: Readonly<Record<"MeetingTagDefinitionV1" | "MeetingTagAssignmentV1" | "MeetingTagStateV1" | "MeetingTagMutationRequestV1" | "MeetingTagMutationReceiptV1" | "MeetingTagFilterV1" | "ResolvedMeetingTagFilterV1" | "MeetingTagSafeAuditEventV1" | "MeetingTagDefinitionListV1", MkcMeetingTagContractSchema>> = {
  "MeetingTagDefinitionV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "display_label": {
        "type": "string",
        "minLength": 1,
        "maxLength": 240
      },
      "normalized_value": {
        "type": "string",
        "minLength": 1,
        "maxLength": 240
      },
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-definition.v1"
      },
      "tag_id": {
        "type": "string",
        "pattern": "^tag_[a-z0-9]{20,64}$"
      },
      "visibility": {
        "type": "string",
        "const": "owner_private"
      },
      "revision": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      },
      "aliases": {
        "maxItems": 100,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "display_label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "normalized_value": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "added_in_revision": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "added_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            }
          },
          "required": [
            "display_label",
            "normalized_value",
            "added_in_revision",
            "added_at"
          ],
          "additionalProperties": false
        }
      },
      "created_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      }
    },
    "required": [
      "display_label",
      "normalized_value",
      "schema_version",
      "tag_id",
      "visibility",
      "revision",
      "aliases",
      "created_at",
      "updated_at"
    ],
    "additionalProperties": false
  },
  "MeetingTagAssignmentV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-assignment.v1"
      },
      "assignment_id": {
        "type": "string",
        "pattern": "^tagasn_[a-z0-9]{20,64}$"
      },
      "meeting_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source_key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "tag_id": {
        "type": "string",
        "pattern": "^tag_[a-z0-9]{20,64}$"
      },
      "revision": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      },
      "state": {
        "type": "string",
        "enum": [
          "active",
          "removed"
        ]
      },
      "assigned_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      },
      "updated_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      },
      "removed_at": {
        "anyOf": [
          {
            "type": "string",
            "format": "date-time",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "schema_version",
      "assignment_id",
      "meeting_id",
      "source_key",
      "tag_id",
      "revision",
      "state",
      "assigned_at",
      "updated_at",
      "removed_at"
    ],
    "additionalProperties": false
  },
  "MeetingTagStateV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-state.v1"
      },
      "meeting_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source_key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "meeting_revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "active": {
        "maxItems": 1000,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "tag_id": {
              "type": "string",
              "pattern": "^tag_[a-z0-9]{20,64}$"
            },
            "display_label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "assignment_revision": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "assigned_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            },
            "removed_at": {
              "type": "null"
            },
            "normalized_value": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "definition_revision": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "assignment_id": {
              "type": "string",
              "pattern": "^tagasn_[a-z0-9]{20,64}$"
            }
          },
          "required": [
            "tag_id",
            "display_label",
            "assignment_revision",
            "assigned_at",
            "removed_at",
            "normalized_value",
            "definition_revision",
            "assignment_id"
          ],
          "additionalProperties": false
        }
      },
      "tombstones": {
        "maxItems": 1000,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "tag_id": {
              "type": "string",
              "pattern": "^tag_[a-z0-9]{20,64}$"
            },
            "assignment_id": {
              "type": "string",
              "pattern": "^tagasn_[a-z0-9]{20,64}$"
            },
            "assignment_revision": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "removed_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            }
          },
          "required": [
            "tag_id",
            "assignment_id",
            "assignment_revision",
            "removed_at"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schema_version",
      "meeting_id",
      "source_key",
      "meeting_revision",
      "active",
      "tombstones"
    ],
    "additionalProperties": false
  },
  "MeetingTagMutationRequestV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-mutation-request.v1"
      },
      "idempotency_key": {
        "type": "string",
        "minLength": 16,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
      },
      "operation": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "create_definition"
              },
              "display_label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 240
              }
            },
            "required": [
              "kind",
              "display_label"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "rename_definition"
              },
              "tag_id": {
                "type": "string",
                "pattern": "^tag_[a-z0-9]{20,64}$"
              },
              "expected_tag_revision": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "display_label": {
                "type": "string",
                "minLength": 1,
                "maxLength": 240
              }
            },
            "required": [
              "kind",
              "tag_id",
              "expected_tag_revision",
              "display_label"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "assign"
              },
              "meeting_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "source_key": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "tag_id": {
                "type": "string",
                "pattern": "^tag_[a-z0-9]{20,64}$"
              },
              "expected_meeting_revision": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "expected_assignment_revision": {
                "anyOf": [
                  {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  {
                    "type": "null"
                  }
                ]
              }
            },
            "required": [
              "kind",
              "meeting_id",
              "source_key",
              "tag_id",
              "expected_meeting_revision",
              "expected_assignment_revision"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "remove"
              },
              "meeting_id": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "source_key": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200
              },
              "tag_id": {
                "type": "string",
                "pattern": "^tag_[a-z0-9]{20,64}$"
              },
              "expected_meeting_revision": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "expected_assignment_revision": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "kind",
              "meeting_id",
              "source_key",
              "tag_id",
              "expected_meeting_revision",
              "expected_assignment_revision"
            ],
            "additionalProperties": false
          }
        ]
      }
    },
    "required": [
      "schema_version",
      "idempotency_key",
      "operation"
    ],
    "additionalProperties": false
  },
  "MeetingTagMutationReceiptV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-mutation-receipt.v1"
      },
      "idempotency_key": {
        "type": "string",
        "minLength": 16,
        "maxLength": 200,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
      },
      "replayed": {
        "type": "boolean"
      },
      "operation": {
        "type": "string",
        "enum": [
          "create_definition",
          "rename_definition",
          "assign",
          "remove"
        ]
      },
      "outcome": {
        "type": "string",
        "enum": [
          "applied",
          "no_op"
        ]
      },
      "tag_id": {
        "type": "string",
        "pattern": "^tag_[a-z0-9]{20,64}$"
      },
      "meeting_id": {
        "anyOf": [
          {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          {
            "type": "null"
          }
        ]
      },
      "tag_revision": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      },
      "meeting_revision": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "assignment_revision": {
        "anyOf": [
          {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "assignment_state": {
        "anyOf": [
          {
            "type": "string",
            "enum": [
              "active",
              "removed"
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "occurred_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      }
    },
    "required": [
      "schema_version",
      "idempotency_key",
      "replayed",
      "operation",
      "outcome",
      "tag_id",
      "meeting_id",
      "tag_revision",
      "meeting_revision",
      "assignment_revision",
      "assignment_state",
      "occurred_at"
    ],
    "additionalProperties": false
  },
  "MeetingTagFilterV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-filter.v1"
      },
      "operator": {
        "default": "and",
        "type": "string",
        "enum": [
          "and",
          "or"
        ]
      },
      "refs": {
        "minItems": 1,
        "maxItems": 20,
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "tag_id"
                },
                "tag_id": {
                  "type": "string",
                  "pattern": "^tag_[a-z0-9]{20,64}$"
                }
              },
              "required": [
                "kind",
                "tag_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "label"
                },
                "display_label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 240
                },
                "normalized_value": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 240
                }
              },
              "required": [
                "kind",
                "display_label",
                "normalized_value"
              ],
              "additionalProperties": false
            }
          ]
        }
      }
    },
    "required": [
      "schema_version",
      "operator",
      "refs"
    ],
    "additionalProperties": false
  },
  "ResolvedMeetingTagFilterV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-filter-resolution.v1"
      },
      "operator": {
        "type": "string",
        "enum": [
          "and",
          "or"
        ]
      },
      "requested_clause_count": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 20
      },
      "resolved_tag_ids": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^tag_[a-z0-9]{20,64}$"
        }
      },
      "unresolved_refs": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "tag_id"
                },
                "tag_id": {
                  "type": "string",
                  "pattern": "^tag_[a-z0-9]{20,64}$"
                }
              },
              "required": [
                "kind",
                "tag_id"
              ],
              "additionalProperties": false
            },
            {
              "type": "object",
              "properties": {
                "kind": {
                  "type": "string",
                  "const": "label"
                },
                "display_label": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 240
                },
                "normalized_value": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 240
                }
              },
              "required": [
                "kind",
                "display_label",
                "normalized_value"
              ],
              "additionalProperties": false
            }
          ]
        }
      },
      "match_semantics": {
        "type": "string",
        "const": "exact_active_assignments_only"
      }
    },
    "required": [
      "schema_version",
      "operator",
      "requested_clause_count",
      "resolved_tag_ids",
      "unresolved_refs",
      "match_semantics"
    ],
    "additionalProperties": false
  },
  "MeetingTagSafeAuditEventV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-audit.v1"
      },
      "operation": {
        "type": "string",
        "enum": [
          "create_definition",
          "rename_definition",
          "assign",
          "remove",
          "filter"
        ]
      },
      "outcome": {
        "type": "string",
        "enum": [
          "applied",
          "replayed",
          "no_op",
          "rejected",
          "conflict"
        ]
      },
      "requested_tag_count": {
        "type": "integer",
        "minimum": 0,
        "maximum": 20
      },
      "resolved_tag_count": {
        "type": "integer",
        "minimum": 0,
        "maximum": 20
      },
      "revision_conflict": {
        "type": "boolean"
      },
      "occurred_at": {
        "type": "string",
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
      }
    },
    "required": [
      "schema_version",
      "operation",
      "outcome",
      "requested_tag_count",
      "resolved_tag_count",
      "revision_conflict",
      "occurred_at"
    ],
    "additionalProperties": false
  },
  "MeetingTagDefinitionListV1": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "schema_version": {
        "type": "string",
        "const": "mkc.meeting-tag-definitions.v1"
      },
      "definitions": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "display_label": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "normalized_value": {
              "type": "string",
              "minLength": 1,
              "maxLength": 240
            },
            "schema_version": {
              "type": "string",
              "const": "mkc.meeting-tag-definition.v1"
            },
            "tag_id": {
              "type": "string",
              "pattern": "^tag_[a-z0-9]{20,64}$"
            },
            "visibility": {
              "type": "string",
              "const": "owner_private"
            },
            "revision": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "aliases": {
              "maxItems": 100,
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "display_label": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 240
                  },
                  "normalized_value": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 240
                  },
                  "added_in_revision": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "added_at": {
                    "type": "string",
                    "format": "date-time",
                    "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
                  }
                },
                "required": [
                  "display_label",
                  "normalized_value",
                  "added_in_revision",
                  "added_at"
                ],
                "additionalProperties": false
              }
            },
            "created_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            },
            "updated_at": {
              "type": "string",
              "format": "date-time",
              "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"
            }
          },
          "required": [
            "display_label",
            "normalized_value",
            "schema_version",
            "tag_id",
            "visibility",
            "revision",
            "aliases",
            "created_at",
            "updated_at"
          ],
          "additionalProperties": false
        }
      }
    },
    "required": [
      "schema_version",
      "definitions"
    ],
    "additionalProperties": false
  }
};
