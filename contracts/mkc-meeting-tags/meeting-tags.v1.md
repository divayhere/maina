# Canonical Manual Meeting Tags Contract v1

P4-01 froze `mkc.meeting-tag-*.v1` as an additive contract. P4-05 binds that
accepted contract to owner-private D1 persistence, canonical Meetings, and the
one existing Recall engine. Semantic tag inference and boosting remain out of
scope.

## Scope And Identity

- A tag definition is private to one authenticated owner in v1. Sharing and
  workspace-wide visibility are out of scope.
- `tag_id` is an opaque, server-generated stable ID. Rename never changes it.
- One `(owner, normalized_value)` may resolve to only one tag across both current
  labels and retained aliases. A conflicting create or rename returns
  `meeting_tag_label_conflict`.
- An assignment has one stable `assignment_id` for a `(meeting_id, tag_id)` pair.
  `meeting_id` and `source_key` remain equal under `mkc.meeting.v1`.

## Labels And Aliases

Clients submit free-form labels. The server applies
`unicode-nfkc-lower-v1`: reject forbidden control and bidirectional formatting
characters, apply Unicode NFKC, collapse whitespace to one ASCII space, trim,
require 1-80 Unicode scalar values and at most 240 UTF-8 bytes, then derive the
duplicate key with locale-independent Unicode lowercase followed by NFKC. The
canonical display label preserves the submitted casing after normalization.

Rename increments the definition revision. If the normalized value changes, the
old display and normalized values are appended as a permanent alias. Case-only
rename changes display casing without adding a duplicate alias. Aliases cannot
be reused by another definition and keep saved filters resolving to the same
stable `tag_id`. Renaming back to a label already retained by the same tag is
allowed; the historical alias remains in place and is not appended twice.

## Mutations, Conflicts, And Tombstones

Every request carries a unique idempotency key and every update carries the
applicable expected definition, meeting, and/or assignment revision. Definition
creation is protected by the namespace uniqueness constraint. Repeating the
same key with the same canonical request returns the original receipt; reusing
it for a different request returns
`meeting_tag_idempotency_conflict`. A stale expected definition, meeting, or
assignment revision returns `meeting_tag_revision_conflict` and performs no
partial write.

Assign/remove is atomic with the canonical meeting mutable revision. Remove
increments both meeting and assignment revisions and retains a tombstone with
`removed_at`; it never hard-deletes history. A stale offline add cannot revive a
tombstone. An intentional re-add must use the current meeting and assignment
revisions, reactivates the same assignment ID, increments revisions, and records
history. Definition and assignment histories are append-only.

Tag mutation may change only the meeting's tag projection, mutable revision, and
`updated_at`. It never changes meeting/source identity, capture evidence,
original transcript, canonical source checksum, corrections, notes, closeout,
processing state, or R2 source bytes, and never regenerates a source.

## Exact Filter Grammar

Meetings and Recall use one structured contract and one URL grammar:

```text
tag=<percent-encoded label-or-alias>&tag=<label>&tag_id=<opaque-id>&tag_mode=and|or
```

`tag` and `tag_id` may repeat, with at most 20 raw clauses. `tag_mode` is optional and
defaults to `and`; it may occur once only. Repeated equivalent labels and IDs are
deduplicated, then references are resolved inside the authenticated owner's tag
namespace. Current labels and aliases resolve identically to stable IDs.

Filtering uses active exact assignments only and runs before list pagination,
Recall corpus census, lexical/semantic retrieval, ranking, or answer synthesis.
AND requires every clause to resolve and match. OR requires at least one resolved
ID to match. An unresolved clause never broadens a query; all-unresolved returns
an empty eligible set. Empty or whitespace-only decoded `tag`/`tag_id`
parameters are ignored before the 20-clause bound and mean no tag constraint
when no nonempty clause remains. In that case `tag_mode` is also ignored;
`tag_mode` without any `tag`/`tag_id` parameter remains invalid. Results and
receipts sort by normalized value then tag ID. Semantic tag interpretation or
boosting is a separately gated future behavior and cannot replace exact filters.

Meeting list and detail projections expose active tags in canonical order. The
tag definition is authoritative for the current display label: projections join
the current definition at read time, so rename is immediately consistent
without rewriting every meeting or advancing unrelated meeting revisions.
Detail/history surfaces may expose assignment tombstones; tombstones never count
as active matches. Recall freezes the resolved IDs, operator, unresolved refs,
complete deterministic eligible-source identity census, its SHA-256, and the
transactional snapshot/watermark in its normal evidence receipt. Every retrieval
lane consumes that frozen identity set. Vectorize receives an exact `source_key`
metadata filter before `topK` only when the complete set fits the platform's
indexed-string and filter-size bounds; otherwise the semantic lane fails closed
and exact lexical/fact retrieval remains available. Deployment therefore requires
an indexed `source_key` metadata property and re-upsert of vectors created before
that index. A snapshot with more than 5,000 tagged source rows is rejected with a
narrow-scope instruction rather than silently truncating eligibility.
Canonical ordering compares Unicode UTF-16 code units directly and does not use
host locale collation.

## Authorization, Privacy, And Compatibility

Tag reads and writes use exact source-level owner authorization. A cross-owner
lookup is indistinguishable from missing (`meeting_tag_not_found`). Labels,
aliases, idempotency keys, meeting/source IDs, and owner identifiers may appear
in authenticated responses where required, but never in routine logs, metrics,
traces, analytics, or error text. Safe audit events contain only operation,
outcome, bounded counts, conflict state, and timestamp.

The existing `mkc.meeting.v1` compact `mutable.tags` projection remains valid as
an owner-visible read projection; it is not authoritative for definition labels
or aliases.
P4-05 adds `GET /v1/meeting-tags`, `POST /v1/meeting-tags/mutations`, and
`GET /v1/meetings/{sourceKey}/tags`. Canonical `GET /v1/meetings` accepts the
repeated exact URL grammar above. Frozen Recall, legacy Recall, and Agent Recall
accept the same structured filter; all adapters resolve it to owner-bound IDs
before calling the shared retrieval engine. Existing requests without tag
constraints retain their prior behavior.

Stable errors are `meeting_tag_label_invalid`, `meeting_tag_label_conflict`,
`meeting_tag_revision_conflict`, `meeting_tag_idempotency_conflict`, and the
owner-safe `meeting_tag_not_found`. A sanitized transient database failure that
did not produce a recoverable receipt returns retryable
`meeting_tag_mutation_unavailable`; clients retry with the same idempotency key.
Read/filter storage failures return sanitized `meeting_tag_read_unavailable`
without emitting labels, IDs, request bodies, driver exception text, or hashes.

## Migration, Rollout, And Reset

Migration `0025_canonical_meeting_tags.sql` is expand-only. It creates empty tag
definitions, namespace claims, assignments, histories, receipts, transaction
guards, and privacy-safe audit state. It never infers a tag or owner from an
existing `canonical_meeting_mutable.tags_json` value. Before production
application, the operator must record read-only counts of nonempty legacy
`tags_json`, ownerless canonical meetings, and current canonical meeting rows;
nonempty legacy projections are a review input, not an automatic backfill.

Rollout applies the additive migration before tag-aware code. Rollback is
code-first: restore the prior application version while leaving the new empty or
populated tables inert. There is no destructive down migration. The immutable
meeting trigger and transcript/source/capture checksum rules remain unchanged.

Deleting one source removes that meeting's assignment history, assignments, and
canonical mutable/immutable rows in one ordered D1 batch, while retaining tag
definitions used by other meetings. Full index reset clears assignment history,
assignments, definition history, namespace claims, definitions, receipts, safe
audits, transaction guards, and canonical meeting projections before clearing
the shared source indexes. Existing source ingestion, transcript/source
promotion, notes regeneration, corrections, retries, and processing-state
updates do not derive from or overwrite authoritative assignment state.
