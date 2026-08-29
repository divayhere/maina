# Release A Contract Handoff

This is the additive Backend/Gateway/Web boundary for Maina Apps. It does not change `mkc.meeting-packet.v1`, mobile capture, source sync, pairing, identity or tenancy.

## Meetings

- `GET /v1/meetings` -> `mkc.meeting-library.v1`. Deterministic `(occurred_at, source_key)` keyset pagination. Query: `q`, `occurred_from`, `occurred_to`, `readiness`, `sort`, `page_size`, `cursor`.
- `GET /v1/meetings/{sourceKey}` -> `mkc.meeting-detail.v1`. Returns effective title/notes, canonical provenance/history and transcript continuation metadata.
- `GET /v1/meetings/{sourceKey}/transcript` -> `mkc.meeting-transcript-page.v1`. Query: `page_size`, `cursor`. Cursor is bound to `source_key` and `transcript_sha256`; a correction invalidates old cursors with `422 meeting_transcript_cursor_invalid`.
- `GET /v1/sources/{sourceKey}/correction-targets` and `POST /v1/sources/{sourceKey}/corrections` remain the append-only correction contract. Corrected decisions/actions/questions rebuild typed Recall facts.

All three Meeting reads require bearer scope `sources:read`. A non-Maina-app meeting returns `404 meeting_not_found`; origin is proven only by stored provenance (`author=maina-app` or `client_schema_version=maina.sync.v1`).

## Frozen Recall

- `GET /v1/recall/searches/{searchId}/open` -> `mkc.frozen-recall-open.v1`.
- `GET /v1/recall/searches/{searchId}/bundle/chapters/{chapterId}` -> `mkc.frozen-recall-chapter.v1`.
- `GET /v1/recall/searches/{searchId}/sources/{sourceKey}` -> `mkc.frozen-recall-source.v1`.
- MCP `open_maina_recall(search_id)`, `continue_maina_recall(search_id, chapter_id)` and `open_maina_recall_source(search_id, source_key)` expose the same frozen objects. Gateway version is `0.8.0`.

These operations do not accept query text and do not rerun retrieval. Result and bundle checksums must match the saved D1 run. Unknown, expired, foreign-owner and integrity-failed results deliberately fail closed with `404`; a source outside the frozen result also returns `404`. This indistinguishable response prevents ownership enumeration.

The published OpenAPI binds all three `200` responses to concrete consumer-decodable schemas. Each response contains `search_id`, `result_sha256`, `bundle_sha256`, `expires_at` and the complete `mkc.coverage-receipt.v1`. Source responses publish the full frozen source/evidence shape. Chapter responses retain every existing chapter field and add the identity envelope. The existing MCP `continue_maina_recall` adapter keeps its compatibility version `mkc.evidence-bundle-chapter.v1` while carrying the same additive checksum and coverage fields.

## Web Handoff

Authenticated Web can reopen a frozen result at `/recall?search_id={opaqueSearchId}`. The URL contains no bearer token, backend address or original query. The Web server reads the existing HttpOnly session cookie and calls the owner-bound backend route. Unauthenticated users follow the normal login boundary; foreign/expired/integrity-failed IDs show the backend failure and never trigger retrieval.

## Published Contract Files

- `contracts/openapi.v0.1.json`
- `src/contracts/index.ts`
- `src/contracts/types.ts`
- `src/retrieval/contracts.ts`

The mobile request contract remains unchanged. Apps may consume these additive read contracts independently; no mobile rebuild is required until an app chooses to expose them.
