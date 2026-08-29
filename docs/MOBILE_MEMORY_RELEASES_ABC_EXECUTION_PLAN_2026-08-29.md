# Maina Mobile Memory Releases A-C — executable plan

**Status:** owner-approved; planning and Mobile Phase M0 active  
**Date:** 2026-08-29  
**Android baseline:** `codex/mainav2-clean-baseline@66d3170`, installed `0.10.32 (58)`  
**iOS baseline:** `codex/ios-feasibility@92515c6`, installed `0.10.31 (14)`  
**Coordination baseline:** `maina-coordination@2f011cf`  

This plan continues the existing Maina mobile program. It does not create a second app, retrieval engine, credential store, pairing flow, canonical memory store, or reliability program.

## Non-negotiable boundaries

- Recording, durable local audio, Qwen ASR, local transcript, notes pipeline, immutable source sync, corrections, To-dos and sharing remain intact.
- Mobile sends no provider key, prompt, provider choice or prompt override.
- `mkc.meeting-packet.v1`, source keys and correction lineage remain unchanged.
- `mainaCloudFetch` and the existing SecureStore session remain the only mobile cloud transport/session boundary.
- MKC remains the canonical cloud-memory owner. SQLite additions are disposable owner-scoped read caches only.
- The existing bottom shell remains Home / microphone / To-dos. Memory enters through the existing drawer and a hidden Router destination; it does not displace the recording-first shell.
- No Expo SDK upgrade, background Pulse poller, mobile chatbot, Universal Link/App Link prerequisite, uninstall or data clear.
- Shared TypeScript changes must be identical on Android and iOS. Native changes remain platform-specific.

## Current evidence and M0 decision

The current final builds prove checkpointed ASR, process-death recovery, centralized notes recovery, immutable source deduplication and completed-audio cleanup. They do **not** contain a recorded physical replay of the exact two scenarios that failed in the five-test campaign:

1. Test 3: incoming WhatsApp/phone call while recording.
2. Test 5: stop offline, finish local ASR, restore network and wait without touching Retry.

Therefore the earlier report is not stale. Both gates remain open until replayed on Android `0.10.32 (58)` and iOS `0.10.31 (14)`.

## Contract stabilization status

Backend source currently contains candidate Release A implementations at backend `46b4851` and Web `a06bfcf`, including deterministic Meetings and exact frozen Recall opening. They are **not yet a mobile dependency baseline** because shared coordination has not recorded a completed deployed Release A contract, and the checked-in exported `contracts/openapi.v0.1.json` does not yet expose all new source-defined paths.

Mobile waits for one coordinated Backend/Web completion event containing:

- exact backend and Web commits;
- production deployment IDs;
- regenerated exported OpenAPI/schemas;
- auth scopes and stable error codes;
- production-safe synthetic qualification;
- additive/no-regression statement for existing mobile contracts.

### Release A contracts required

Candidate contracts already visible in backend source, pending export/deployment stabilization:

- `GET /v1/meetings`
  - query: `q`, `occurred_from`, exclusive `occurred_to`, `readiness`, `sort`, `page_size`, `cursor`;
  - response schema: `mkc.meeting-library.v1`;
  - stable total, filter-bound cursor, newest/oldest ordering and canonical source key.
- `GET /v1/meetings/{sourceKey}`
  - response schema: `mkc.meeting-detail.v1`;
  - corrected summary/lists, provenance, readiness and correction lineage.
- `GET /v1/recall/searches/{searchId}/open`
  - owner-bound, expiry-checked, checksum-verified frozen object;
  - no reretrieval.
- `GET /v1/recall/searches/{searchId}/bundle/chapters/{chapterId}`
  - checksum-bound continuation.
- Existing correction targets/history remain under `/v1/sources/{sourceKey}/...`.

Still required before Mobile Release A implementation can finish:

- a bounded transcript-page/continuation schema for cloud meeting detail; the current candidate detail embeds all blocks and is unsafe for unbounded mobile rendering;
- exported strict response schemas for Meetings, meeting detail, frozen open and chapter continuation;
- an authenticated ordinary HTTPS Web handoff URL shape containing no token;
- stable expiry, owner-mismatch, cursor-mismatch and checksum-mismatch error codes.

Mobile will not invent endpoint names or approximate these responses.

### Release B contracts required

No stabilized Pulse contract exists yet. Backend/Web must supply:

- one owner-bound deterministic Pulse read endpoint and versioned response schema;
- receipt/corpus watermark, generated/refreshed time and coverage quality;
- evidence-linked recent sources, decisions, actions, deadlines, changed decisions and questions;
- explicit distinction between `none_found` and `insufficient_structured_coverage`;
- bounded pagination/drill-down identities and stable errors.

### Release C contracts required

No stabilized saved-Recall contract exists yet. Backend/Web must supply:

- owner-scoped saved Recall list/detail/create/update/delete schemas;
- manual-run response that identifies one frozen search/result/bundle;
- immutable original query plus explicit filters;
- corpus watermark, planner version and comparability status;
- source/fact/correction identity-based new/changed/removed deltas;
- stable expired, foreign-owner and non-comparable error states.

## Phase M0 — reliability and distribution truth

### Existing files and mechanisms

Shared:

- `src/app/_layout.tsx`: app-active, native-event and network-restored reconciliation.
- `src/services/backgroundPipeline.ts`: one idempotent recovery drain.
- `src/services/meetingPacket.ts`: durable retryable notes state and bounded job reuse.
- `src/services/mainaKnowledgeCloud.ts`: frozen immutable source retry.
- `src/services/cloudRetryPolicy.ts`: retry schedule.
- `src/data/db.ts` and `src/data/meetings.ts`: durable stages and next-attempt state.

Android native:

- `MainaRecordingService.kt` and `MainaCallInterruptionPolicy.kt`: call/communication pause-resume.

iOS native:

- `MainaIOSNativeAudioCapture.swift`: interruption close, bounded same-meeting recovery and foreground fallback.
- `MainaIOSContinuedProcessing.swift`: deferred processing boundary.

### Exact physical gates

Test 3 on each phone:

1. Start one meeting and narrate a pre-call marker.
2. Answer WhatsApp call for 30-60 seconds, narrate only inside the call, end it, then narrate a post-call marker.
3. Repeat with a rejected/no-answer call.
4. Separately manually pause, trigger/end a call and verify no auto-resume.
5. Stop normally.
6. Verify same meeting ID, `system_paused`, post-call continuation, excluded call interval, durable chunks, final transcript, notes and exactly one source.

Test 5 on each phone:

1. Start online and record a synthetic fixture.
2. Remove connectivity before Stop and save.
3. Let local ASR complete offline.
4. Restore connectivity and touch no retry/rewrite/sync control.
5. Verify retryable user wording, bounded next-attempt state, automatic notes, automatic immutable source sync, same cloud job/source identity and no raw hostname/error.
6. Force-close during one retry round, relaunch and verify continuation without duplication.

Repeat the already-passed process-death and audio-cleanup checks after any fix. No Memory surface is promoted until all M0 gates pass.

### M0 owner action

- Answer/reject the physical calls when requested.
- Restore a usable Xcode account session for signing team `9X4X3R4KCN` before the current Personal Team profile expires, then run the data-preserving weekly renewal gate.

## Phase M1 — generated contracts, shared client/cache and disabled shell

### Shared files

Add only after the Release A export is stable:

- `src/services/mkc-memory-contracts.ts`: strict decoders copied/generated from the exported versioned schemas.
- `src/services/mkc-memory-client.ts`: finite/cancellable reads over `mainaCloudFetch`; no Axios and no second auth layer.
- `src/services/mkc-memory-cache.ts`: owner-scoped last-good cache operations.
- `src/services/mkc-memory-links.ts`: authenticated Web fallback and safe share manifest construction.
- `src/services/mkc-memory-presentation.ts`: truthful labels for readiness, expiry, coverage and staleness.
- `src/services/mkc-memory-flags.ts`: independent flags, all false by default.
- `src/app/(tabs)/memory/_layout.tsx` and `index.tsx`: disabled route shell only.
- `src/design/shell.tsx`: add Memory to the drawer only when its surface flag is enabled.

### SQLite migration

Append one migration; never edit shipped migrations. Add a rebuildable table equivalent to:

```sql
CREATE TABLE mkc_memory_cache (
  owner_user_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  etag TEXT,
  checksum TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_accessed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, cache_key)
);
CREATE INDEX idx_mkc_memory_cache_owner_access
  ON mkc_memory_cache(owner_user_id, last_accessed_at);
```

Rules:

- cache only validated responses;
- key by owner + normalized resource/filter/cursor identity;
- retain last-good data after a read failure;
- bound payload bytes and expiry; do not cache unbounded transcript/bundle data;
- clear owner-bound cloud cache on sign-out while preserving all local meetings/audio/transcripts;
- corruption or schema-version mismatch deletes only affected cache rows.

### Flags

- `mobile_memory_surface_v1`
- `mobile_cloud_meetings_v1`
- `mobile_frozen_handoff_v1`
- `mobile_memory_pulse_v1`
- `mobile_saved_recalls_v1`
- `mobile_verified_links_v1` remains false and out of Releases A-C.

M1 ships no visible Memory UI. If remote flag delivery is not provided by a stabilized additive backend capability contract, flags remain build-time defaults and rollback is an in-place app update plus server-side endpoint disablement.

### M1 tests

- strict decode and fail-closed required fields/checksums;
- forward-compatible unknown optional fields;
- owner-isolated cache keys;
- stale last-good cache behavior;
- sign-out clears cloud cache only;
- no token/hostname/stack in user errors, links or logs;
- disabled route absent from drawer and does not alter Home/microphone/To-dos;
- shared-file SHA parity across branches.

## Phase M2 — Mobile Release A

### Screens and components

- `src/app/(tabs)/memory/index.tsx`: compact Memory home.
- `src/app/(tabs)/memory/meetings.tsx`: virtualized deterministic list, search/date filters and pull-to-refresh.
- `src/app/(tabs)/memory/meeting/[source-key].tsx`: read-only cloud detail with paginated transcript.
- `src/app/(tabs)/memory/recall/[search-id].tsx`: exact frozen result, expiry/coverage/checksum truth and chapter continuation.
- Small reusable components outside `src/app`, following existing `src/design` tokens; no second theme.
- Existing local meeting detail adds only `Open cloud record` when a canonical source key exists.

### Behavior

- Drawer entry preserves the established bottom shell.
- Cloud-only and local-and-cloud meetings are visibly distinct; no fabricated local row.
- `FlatList` renders unknown/large lists and transcript pages.
- Reads use cancellation, finite retry and last-good cache, not the durable mutation outbox.
- Open/share uses the exact frozen search identity and checksums; expiry/mismatch fails closed.
- Ordinary authenticated HTTPS Web fallback first; no Universal/App Link entitlement change.

### M2 gates

- total/order/cursor traversal with zero duplicates or gaps;
- local/cloud identity stitching;
- corrected projection/history;
- Android/iOS/Web same canonical meeting visibility;
- frozen result and bundle checksum agreement;
- expiry, owner mismatch and checksum mismatch failures;
- long transcript pagination without memory pressure;
- offline cache/staleness and pull-to-refresh;
- system share contains no token and no default raw transcript;
- recording and local pipeline regression suite remains green.

## Phase M3 — Mobile Release B

- Add Pulse inside the existing Memory surface, never as a new root product.
- Render backend-supported recent sources, actions, explicit deadlines, decisions/changes and questions.
- Every item opens its exact source/fact.
- Show receipt/watermark and last refresh; offline displays last-good data as stale.
- Never locally infer urgency, owner, deadline or “nothing found.”
- Manual refresh plus foreground stale refresh only; no background poller or notifications.

Gates: deterministic count reconciliation, timezone/deadline boundaries, sparse-coverage truth, lineage links, offline last-good behavior, provider-outage independence and idle battery comparison.

## Phase M4 — Mobile Release C

- Add saved Recall list/detail/manual run to Memory.
- Open the latest exact frozen result and identity-based delta.
- Display non-comparable planner/scope changes as `Refresh baseline`.
- Keep complex creation/editing Web-first initially; expose `Create on Web`.
- Manual pre-meeting handoff freezes and shares one exact packet; mobile does not author the brief.

Gates: owner isolation, original-query preservation, relative-date reevaluation, source/fact/correction delta correctness, zero ranking-only deltas, deleted/superseded truth, planner comparability and exact packet handoff.

## Branch and parity procedure

1. Start each phase from clean pushed Android/iOS heads and current coordination.
2. Create one shared commit on Android for contracts/client/cache/presentation/routes/tests.
3. Apply the same shared patch/commit to iOS; resolve only documented platform differences.
4. Keep Android native and iOS native changes in separate commits.
5. Compare a phase manifest of all Memory shared files by SHA-256; require exact equality.
6. Run complete gates independently on both branches.
7. Advance coordination pointers and record both heads/build identities.

The present broad branch diff is historical platform work, not permission to overwrite either branch wholesale.

## Build, install and rollback

Build only after a phase's source/contract gates pass.

Android:

- use `/Users/divay/Developer/MainaV2` and `docs/BUILD_HYGIENE_RUNBOOK.md`;
- clean dependency/toolchain/release verification;
- one newer signed APK;
- exact authorized Pixel target;
- preserving in-place install only.

iOS:

- use `/Users/divay/Developer/.worktrees/maina-ios-feasibility`;
- preserve `ios-tests/MainaUITests.swift` and `scripts/stop-dual-device-soak.sh`;
- verify signing/profile expiry before building;
- install in place on exact iPhone 15; never uninstall;
- count and compare meetings, transcript blocks, To-dos and pipeline stages before/after.

Rollback:

1. disable the affected Memory flag/surface;
2. preserve local capture, local transcript, cloud packet and source sync;
3. leave additive backend contracts and disposable cache dormant;
4. issue a preserving in-place app update only if needed;
5. never clear local data.

## Phase reporting

At every boundary record, without secrets or customer content:

- Android/iOS commits and coordination commit;
- exported contract/schema version and Backend/Web deployments;
- automated test counts;
- exact installed build/device identities;
- physical scenario results and duplicate checks;
- rollout flag state;
- residual platform limits and exact next action.

