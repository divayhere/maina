# ADR 0008 — Block transcript storage and recovery safety

Status: **Accepted for the next combined build specification (not yet implemented)**  
Date: **2026-08-19**

## Decision

Maina will stop treating a meeting transcript as one monolithic string for live capture, viewing, recovery, and automatic diagnostics.

The next combined build will:

- store transcripts as timestamped SQLite blocks, not as one live-rendered blob
- keep only one mutable draft block per meeting; completed blocks become immutable
- keep the existing `meetings.transcript` column only as a read-only fallback for older meetings
- show only a recent live tail while recording, not the whole meeting history
- render full history through a paged `FlashList` viewer
- export/share transcript text through an explicit async file build, not through a render-time whole-text mount
- keep structured diagnostics and audio/debug artifacts separate from transcript text

## Context

The confirmed 72-minute ANR was caused by Maina opening a very large transcript through one React Native text surface:

- `src/app/record.tsx` accumulates the meeting transcript in one growing string and mirrors it into React state
- `src/app/meeting/[id].tsx` renders the full transcript in a `ScrollView` as one `AppText`
- stop/recovery flows still queue the entire transcript text again as a diagnostics artifact

This is unsafe for Maina's real workload. The user expects 2–3 hour meetings and must be able to open the app during or after capture without risking the recorder.

Current platform guidance supports this direction:

- React Native documents that `ScrollView` renders all children at once and recommends virtualized list components for long content.
- React Native's performance guide explicitly points to FlashList as a large-list optimization option.
- FlashList's own docs require release-mode performance testing and stable recycling keys.
- Android documents that `SpeechRecognizer` is not intended for guaranteed continuous recognition, so durable audio remains Maina's source of truth even when the transcript UI is fixed.
- Android's ANR guidance confirms that input-dispatch ANRs come from main-thread unresponsiveness.

## Chosen design

### 1. Block-first transcript schema

Add a new `transcript_blocks` table without deleting or rewriting legacy transcript blobs during migration.

Minimum shape:

- `block_id TEXT PRIMARY KEY NOT NULL`
- `meeting_id TEXT NOT NULL`
- `sequence INTEGER NOT NULL`
- `status TEXT NOT NULL CHECK(status IN ('draft','final'))`
- `segment_index INTEGER`
- `started_at INTEGER`
- `ended_at INTEGER`
- `language TEXT`
- `speaker_id TEXT`
- `text TEXT NOT NULL`
- `word_count INTEGER NOT NULL DEFAULT 0`
- `char_count INTEGER NOT NULL DEFAULT 0`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Required indices:

- ordered lookup by `meeting_id, sequence`
- unique draft block per `meeting_id`
- unique final sequence per `meeting_id`

### 2. One mutable draft block

Maina may update only one small draft block while speech is actively changing.

Rules:

- partial results update the current draft block
- final results merge only against the current draft block or the tail of the previous final block
- when the draft exceeds a conservative cap, or a hard boundary occurs, it is finalized and a new draft begins
- final blocks are never reopened

Recommended first-pass caps:

- approximately 20–30 seconds of speech
- or approximately 100–150 words
- or approximately 800 characters
- whichever arrives first

These are intentionally conservative to protect UI and export paths; they can be tuned only after release-mode soak evidence.

### 3. Legacy transcript compatibility

Do not backfill old meetings into blocks during migration.

Compatibility rule:

- if a meeting has transcript blocks, the viewer/exporter uses blocks
- if it has no blocks but still has `meetings.transcript`, the viewer synthesizes a single legacy block at read time

This avoids a risky startup migration and preserves existing recordings.

### 4. Viewer split by responsibility

The live record screen and the detail screen must no longer share the same transcript behavior.

Record screen:

- shows only a recent tail window plus the current draft block
- never mounts the whole meeting transcript
- remains optimized for capture trust, not archival reading

Meeting detail:

- uses `@shopify/flash-list`
- pages block rows from SQLite
- uses a stable `keyExtractor`
- uses `getItemType` for transcript rows vs metadata/recovery rows if needed

### 5. Recovery-first routing

Interrupted meetings should open into a lightweight recovery screen before any large text is mounted.

That screen should show:

- started time
- current status
- segment counts
- recovered audio duration
- whether saved audio still exists
- buttons for `Open transcript`, `Export`, and `Retry transcription` when appropriate

This keeps the app inspectable even after another long-session incident.

### 6. Export is explicit and asynchronous

Transcript export must be built from paged block reads and written to a file before share.

Implications:

- no render path may depend on one giant `join()` for display
- `Copy all` may assemble a string on explicit user action
- `Share as Markdown` / `Share as text` should use a generated file path rather than message-only sharing for long meetings

### 7. Diagnostics separation

Routine diagnostics should carry structure, not transcript payload.

Keep:

- heartbeats
- restart counts
- route changes
- capture gaps
- process/memory breadcrumbs
- artifact counts and failures

Do not keep in the hot path:

- automatic full transcript text artifact uploads during stop or recovery

Audio artifact uploads remain a separate debug lane and must never block the structured event lane.

## Consequences

### Positive

- Opening Maina after a long meeting no longer depends on measuring one giant Android text node.
- Capture and transcript viewing are cleanly separated, so the UI cannot easily take the recorder down with it.
- Old meetings remain readable without a dangerous migration.
- Timestamps become a stable foundation for later export, audio seek, and optional diarization.

### Tradeoffs

- The repository becomes more complex because transcript data is no longer one column.
- Export/share needs an explicit file-building path.
- The record screen no longer shows unlimited scrollback; this is intentional and preferred for reliability.

## Build implications

The next combined implementation must change at least:

- `package.json` / `package-lock.json`
- `src/data/db.ts`
- `src/data/meetings.ts`
- `src/core/transcription/transcript.ts` or a new adjacent helper
- `src/app/record.tsx`
- `src/app/meeting/[id].tsx`
- `src/app/_layout.tsx`
- `src/app/(tabs)/index.tsx`
- `src/services/remoteLog.ts`
- `modules/maina-recorder/src/index.ts`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsStore.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsWorker.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt`
- `scripts/verify-release.sh`

## Validation standard

This ADR is not complete until one release-mode Pixel build passes all of the following together:

1. 3-hour screen-off capture while charging.
2. Repeated app open/close during and after capture.
3. Transcript detail scrolling without ANR.
4. Export/share from a long meeting.
5. Interrupted-process recovery path.
6. One microphone-route transition.
7. Durable diagnostics visible after the run without transcript text in the structured event lane.
