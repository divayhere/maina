# Maina implementation ledger

This file is the durable source of truth for what is built, what has automated evidence, and what still requires a Pixel test. Update it in the same change as every feature.

## v0.10.6 correction lineage and silent input continuity — 2026-08-22

Maina 0.10.6 (versionCode 32) is implemented, release-qualified, and installed on the Pixel with existing app data preserved.

- Regenerated meeting title, summary, decisions, to-dos, and open questions are frozen as independent `mkc.correction.v1` rows after an immutable source snapshot exists. Later field versions explicitly supersede the prior correction key. The original source and transcript are never rewritten.
- Correction retries reuse the exact stored JSON body. Authentication, conflict, validation, budget, and retryable outcomes remain distinct; auth failures require a deliberate settings save before retry.
- Android native capture now treats external devices as replaceable input routes. USB receiver, wired headset, Bluetooth SCO, and built-in phone mic changes rebuild `AudioRecord` inside the same meeting, finalize the current crash-safe WAV chunk, and retry with bounded backoff without pausing or stopping the user session.
- Existing receiver continuity is preserved during transmitter-only Hollyland switching because Android still sees one receiver route; a receiver disconnect falls back to Android's default phone input.
- Automated proof: TypeScript, lint, 16 test files/73 tests, Expo dependency checks, Expo Doctor 21/21, Android export, native recorder unit tests, Kotlin compilation, release manifest assertions, signed arm64 assembly, and signature verification all pass.
- Real-device proof: retained-data upgrade to 0.10.6 succeeded; local native capture and Qwen ASR produced 35 words from the final smoke; Gemini generated notes/decision/to-do; MKC source ingest returned HTTP 201; the meeting UI refreshed itself to `Synced to cloud`; a deliberate notes regeneration froze and synced five linked correction records (title, summary, decisions, to-dos, and open questions), all returning HTTP 201.
- Still pending real-world evidence: physically disconnect/reconnect USB and Bluetooth inputs during one session, and complete the controlled three-hour overnight soak. The implementation and policy tests are green, but those hardware/long-duration claims remain unqualified until those tests run.

## Controlled long-session qualification preparation — 2026-08-22

`scripts/android-soak-monitor.sh` is now the release-mode Pixel soak harness. It does not start the meeting itself: it waits for a real locked-screen clicker start, timestamps the observed `Maina is recording` state, resets battery statistics, captures logcat plus one-minute battery/temperature/memory/storage/audio-permission heartbeats, and schedules redundant stop-and-save commands on both the phone and Mac after the requested duration. It then observes post-call transcription and packet work before collecting final Android evidence.

The harness passed Bash syntax, failure-path argument checks, repository diff checks, and a live preflight against the installed Pixel/Maina 0.10.5 state. The actual three-hour run remains the qualification gate; adding a harness is not evidence that the app passed the soak.

## Local implementation status — 2026-08-19

The following batch is now implemented locally and has passed the automated release gate. No APK was built from this batch yet.

| # | Item | Local implementation status | Automated evidence | Still needs Pixel / release test |
|---:|---|---|---|---|
| 1 | Long-transcript safety and recovery viewer | Implemented | Transcript blocks added; Record screen now keeps only a small live tail; meeting detail moved to paged `FlashList`; interrupted meetings route to a lightweight recovery screen first | Multi-hour open/scroll/export on device |
| 2 | Durable native recording diagnostics | Implemented | Native service heartbeat, storage snapshot, retained-audio accounting, and diagnostics purge path compile and pass release verification | Confirm Supabase/Sentry timelines during real long captures |
| 3 | Long-session QA gate | Harness implemented; qualification pending | Release verifier, QC matrix, and `scripts/android-soak-monitor.sh` preflight pass | Complete the controlled three-hour Pixel run and inspect its evidence |
| 4 | Timestamp-ready transcript schema | Implemented | SQLite migration v5 adds `transcript_blocks` with timestamps/language/speaker seam; repository helpers and tests pass | Verify timestamps remain usable across long sessions |
| 5 | Optional later speaker diarization seam | Implemented as seam only | Schema/UI accept nullable `speakerId`; no fake labels rendered | Future diarization engine only |
| 6 | Storage-pressure resilience and staging cleanup controls | Implemented for staging | Shared storage budget gate, maintainer cleanup actions, and purge APIs compile and pass tests | Validate low-space behavior on device |
| 7 | Battery and performance budget gate | Instrumented; qualification pending | Native heartbeat plus soak harness capture battery, temperature, voltage, PSS, free storage, audio AppOps and final batterystats | Collect and assess the three-hour Pixel evidence |

### Known remaining software-level tradeoffs before the next APK

- Export/share still rebuilds the full transcript text on explicit user action. This is acceptable for now because it is not part of the hot recording/view path, but it remains the next optimization target for very large meetings.
- Saved-audio re-transcription currently clears the existing transcript before rebuilding it. That keeps the flow deterministic, but if a re-pass fails halfway the previous transcript is not automatically restored. This is a known follow-up safety improvement, not a hidden regression.
- Staging cleanup is intentionally aggressive for current testing: it removes all non-recording meetings. Before any broader sharing, this should become retention-aware rather than “clear test data” oriented.

## v0.10 capture-first ASR staging — 2026-08-20

This is an installed local staging build on the Pixel. The final v0.10.0 APK was
installed in place, preserving the current model pack, settings and meeting
data.

| # | Item | Status | Evidence | Release blocker |
|---:|---|---|---|---|
| 1 | Capture-first ADR and ASR contracts | Implemented | `0009-capture-first-modular-local-asr.md`, `ASR_MODULE_CONTRACT.md` | None |
| 2 | Deterministic ASR quality/coverage controller | Implemented | Windowing, short-tail merge, overlap de-duplication and lifecycle tests; full suite 47/47 passes | Hindi/Hinglish and long-run qualification |
| 3 | Service-owned PCM/WAV chunk engine | Implemented in recorder staging path | Crash-safe partial WAVs, finalization/inspection/recovery, native compilation and device proof | 2–3-hour capture/recovery soak |
| 4 | Official sherpa-onnx Android runtime | Validated and added | Official v1.13.6 AAR, SHA-256 `0012d9a28f15bd6fb966b62b70a75da3990512fdccce28b83098248ce4be1698` | Qwen model-pack installer + device proof |
| 5 | Qwen model pack | Installed outside APK; short-run Pixel qualified | 26.119 s USB-mic recording decoded in 4.640 s with full interval coverage; app remained alive; packet generated | Installer/update flow, thermal and Hindi/Hinglish/long-run tests |

### Local APK / device evidence

- APK: `/Users/divay/Desktop/Software/Maina/android/app/build/outputs/apk/release/app-release.apk`
- Version: `0.10.0`; Android version code: `26`.
- APK SHA-256: `e1292df5ab5ee55c077566824c65f094363f27c4b60a5d6bc5e1917eec5a66e5`
- APK v2 signature verification passed. The signing certificate SHA-256 remains
  `4715df74d9a72125848ea45c0f15d2d2e75f25ada4203a406c390be0aac443b4`.
- Installed in place with ADB on the connected Pixel as a standalone release
  build; no Expo cloud build credit was used and app data was retained.
- Maina Accessibility was enabled after install; `RECORD_AUDIO` and
  `POST_NOTIFICATIONS` were granted.
- App launch smoke passed in release mode: React Native started from the bundled
  app, with no Metro dependency and no fatal AndroidRuntime crash in the launch
  or transcription samples.
- A real USB-microphone recording finalized to one durable WAV with no partial
  chunks. Its 26.119-second local-Qwen pass completed in 4.640 seconds, produced
  23 words, covered the complete interval and did not trigger the suspicious-
  output gate.
- The same flow automatically generated a Gemini packet using the saved setup.
  The meeting UI refreshed to `Packet ready` with a summary, one decision and
  one open to-do. This closes the observed packet-setup/retry failure.
- `npm run verify:release` passed TypeScript, ESLint, dependency checks, Expo
  Doctor 21/21, production export, Kotlin/app compilation, native tests, the
  release verifier and 47 Vitest cases across 11 files.

### Current guardrails

- The staging recorder uses native capture + post-stop Qwen. The older
  Expo/Android SpeechRecognizer path remains in the codebase as a rollback seam,
  but it is not the active final-transcript path in this local staging build.
- The native capture worker has no ASR/network/UI work in its hot loop.
- ASR work runs away from Android's main thread. Audio is processed in bounded
  windows and the recognizer is cached only for that pipeline run, then released.
- Qwen is not embedded into the APK. A verified, resumable model-pack
  install/update flow is still needed before this can become a normal user
  release.
- Speaker diarization and `You` voice identification remain contract seams, not
  implemented features. Maina must not invent speaker labels meanwhile.
- The current proof is deliberately limited: Hindi/Hinglish accuracy, a
  60-minute transcription, a 2–3-hour lock-screen soak, thermal/battery behavior
  and microphone-route transitions remain open gates. v0.10.0 must therefore be
  treated as a staging/day-to-day test build, not a bug-free production claim.

## Approved next-build backlog — batch only, no APK until explicitly authorised

Historical planning snapshot retained for traceability. The authoritative current state for this batch is the “Local implementation status — 2026-08-19” section above.

This section is the ordered scope for the next combined local build. Add decisions here while testing; do **not** make one-off APKs for individual items. Nothing below is built yet.

| # | Item | Why it is mandatory | Definition of done |
|---:|---|---|---|
| 1 | **Long-transcript safety and recovery viewer** | v0.9.3 produced an Android input-dispatch ANR after a 72-minute live capture because the Record screen mounted the whole transcript as one `ScrollView`/`Text`. The UI must never be able to stop the recorder. | Store transcript as small, timestamped SQLite blocks; persist complete blocks independently; use a virtualized `FlashList` viewer; keep only one small live block updating; never mount/copy the whole transcript merely to display it; use a lightweight interrupted-recording recovery screen before opening text. A 3-hour Pixel soak can be opened, navigated and exported without ANR or unbounded memory growth. |
| 2 | Durable native recording diagnostics | The long-session Supabase timeline was absent after the UI ANR, leaving no remote evidence for the failure. | Recording/service heartbeats, route changes, segment closure, recognizer health, memory/process state and terminal recovery state reach the durable outbox independently of the transcript screen. Diagnostics exclude transcript/audio content. |
| 3 | Long-session QA gate | Maina is intended for 2–3 hour meetings; short functional tests are insufficient. | Release-mode Pixel protocol covers 3-hour lock-screen capture, repeated app open/close, scrolling, export, forced process-death recovery and a microphone-route transition. No ANR, completed blocks retained, recovery result recorded. |
| 4 | Timestamp-ready transcript schema | Timestamps make long transcripts readable and enable later audio seek/retry/diarization without changing the viewer again. | Every block has sequence number, approximate capture start/end, language and text. `speakerId` is nullable and not shown as a fabricated label. |
| 5 | Optional later speaker diarization seam | Speaker labels improve usefulness, but current Android live ASR does not reliably identify speakers. It must not compromise capture reliability. | The schema/UI can accept real diarization labels later; diarization stays a separate post-processing module and cannot block or alter recording. |
| 6 | Storage-pressure resilience and staging cleanup controls | Long captures, exports, and retained recovery audio can fail in the exact moments when disk space is low. During staging, old meetings are disposable, so Maina should help us cleanly recycle test data instead of silently degrading. | Maina measures free space before recording/export/re-pass, records low-storage warnings in diagnostics, preserves the active meeting before deleting anything, enforces a predictable recovery budget, and offers a maintainer-facing purge path for old staging meetings/audio/diagnostic artifacts. |
| 7 | Battery and performance budget gate | The app is only trustworthy if it stays armed/recording without draining the phone excessively or regressing CPU/memory after transcript changes. | Release-mode QA captures armed-idle CPU/battery, recording battery slope, wake-lock behavior, and memory growth during a 3-hour run. The diagnostics timeline stores enough structured evidence to compare builds without re-running every investigation from scratch. |

### Locked design choice for item 1

- Use `@shopify/flash-list` directly, not a WebView or a specialised transcript/chat viewer.
- Break on final speech results, speaker turns when genuinely known, or a conservative text/time cap. Timestamps are shown; speaker remains `Unknown` until a real diarization engine supplies it.
- Full `.md`/`.txt` export reads blocks from storage incrementally. The complete transcript may be copied/exported, but is never rendered as one Android text node.
- Audio capture, transcript storage, viewer, export, diagnostics and future diarization remain separate modules.

## v0.10 pre-build audit — 2026-08-19

Historical pre-implementation audit retained for context. The codebase has since advanced beyond this snapshot.

This section is the approved implementation specification for the next combined build. It reflects the live code on `0.9.3`, the 72-minute ANR evidence, and current React Native / Android / Supabase guidance. Nothing in this section is built yet.

### What the current code confirms

- `src/app/record.tsx` still keeps the live transcript as one ever-growing string in `finalRef.current`, mirrors it into React state with `setFinalText()`, persists that same blob into `meetings.transcript`, and queues the full transcript again as a text artifact on stop.
- `src/app/meeting/[id].tsx` still renders the entire meeting transcript inside a `ScrollView` as one `AppText` node.
- `src/app/_layout.tsx` still queues the entire recovered transcript as a diagnostics text artifact after interrupted-meeting repair.
- `src/data/meetings.ts` still models transcript storage as one nullable `meetings.transcript` column and has no block repository yet.
- The current long-session failure is therefore architectural, not cosmetic: even if capture continues correctly, opening a large transcript can still freeze the foreground UI.

### Web-validated constraints behind the next build

- React Native documents that `ScrollView` renders all children at once and recommends `FlatList` for long content; its performance guide also points to FlashList for large-list workloads.
- FlashList's own guidance says to test performance in release mode, keep `keyExtractor` stable, and use `getItemType` when rows differ.
- Android documents that `SpeechRecognizer` is not intended for guaranteed continuous recognition, which reinforces Maina's rule that durable audio remains the source of truth.
- Android ANR guidance confirms that input-dispatch ANRs are main-thread responsiveness failures, so the transcript viewer must never depend on measuring the whole meeting at once.
- Supabase documents that exposed objects need both explicit grants and RLS, and Storage uploads also depend on RLS policies. The diagnostics design must therefore stay simple, explicit, and least-privilege.

### Deliberate simplifications for the next batch

- Do not eagerly migrate old `meetings.transcript` blobs into block rows during app upgrade. Old meetings stay readable through a legacy fallback path; new and reprocessed meetings use block storage.
- Do not keep the whole transcript visible on the live record screen. The recorder shows only a recent tail window plus the current draft block; the detail screen owns full-history viewing.
- Do not add speaker diarization, rich-text rendering, search indexing, or WebView-based transcript rendering in this batch.
- Do not keep automatic full-transcript uploads in the diagnostics hot path. The durable diagnostics lane keeps structured health and artifact metadata; transcript text remains export-oriented rather than telemetry-oriented.
- Because this is still a staging build, compatibility should not be protected at the cost of reliability. Old meetings may be purged manually if a cleaner test baseline is more useful than preserving them.

### Exact files in scope for the next combined build

| Area | Files to change | Purpose |
|---|---|---|
| Dependencies | `package.json`, `package-lock.json` | Add the Expo-compatible `@shopify/flash-list` package and a file-sharing dependency for `.md` / `.txt` export. |
| Schema | `src/data/db.ts` | Add the next migration for timestamped `transcript_blocks` plus indices for ordering and the single mutable draft block. |
| Transcript repository | `src/data/meetings.ts` | Add block CRUD, paging, export assembly, summary counts, and a legacy transcript fallback reader. |
| Transcript chunking | `src/core/transcription/transcript.ts` or a new adjacent helper | Move overlap-merge logic from whole-transcript strings to block-tail-safe merging and chunk-finalization rules. |
| Live recorder | `src/app/record.tsx` | Replace whole-string state with one mutable draft block plus a small recent block window; stop writing/queuing the monolithic transcript blob. |
| Meeting detail | `src/app/meeting/[id].tsx` | Replace `ScrollView` transcript rendering with a paged `FlashList` block viewer and file-based export/share. |
| Recovery routing | `src/app/_layout.tsx`, `src/app/(tabs)/index.tsx`, new lightweight recovery route | Ensure interrupted meetings open into a metadata-first recovery screen instead of mounting a large transcript immediately. |
| Diagnostics bridge | `src/services/remoteLog.ts`, `modules/maina-recorder/src/index.ts` | Remove automatic giant transcript artifact usage from the hot path; keep structured run summaries and artifact control explicit. |
| Native durability | `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/DiagnosticsStore.kt`, `DiagnosticsWorker.kt`, `MainaRecordingService.kt`, `MainaRecorderModule.kt` | Add service-owned heartbeats, route-state snapshots, and process/memory breadcrumbs that survive a React Native freeze. |
| Storage/maintenance | `src/app/diagnostics.tsx`, `src/data/meetings.ts`, native diagnostics store/worker files | Add free-space visibility, staging cleanup actions, and oldest-safe-first retention enforcement that cannot delete the active run. |
| Release gate | `scripts/verify-release.sh` | Add transcript-safety guards so release verification fails if the full transcript is still rendered or automatically uploaded as one blob from the hot path. |

### Proposed transcript storage shape

The next migration should add `transcript_blocks` without rewriting legacy rows:

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

- ordered lookup by meeting and sequence
- one unique draft block per meeting
- one unique final sequence per meeting

Operational rule:

- Final blocks are immutable.
- Only one small draft block may be updated in place.
- Legacy meetings with zero block rows continue to read from `meetings.transcript` until they are explicitly reprocessed.

### Migration and data-loss risks to handle explicitly

| Risk | Why it matters | Required handling |
|---|---|---|
| Eager transcript backfill | Turning old large transcripts into block rows during migration can make startup slow or fragile on the exact devices we are trying to stabilize. | Add the table only. Read old meetings through a compatibility path. No automatic backfill job in this batch. |
| Re-pass still writes a monolith | `meeting/[id].tsx` currently accumulates one big `textRef` and overwrites `meetings.transcript` at the end. | Re-pass must write blocks as it goes and only keep a small current draft in memory. |
| Export path recreates the ANR shape | A safe viewer is not enough if export/share rebuilds the transcript on the main thread during render. | Build export as an explicit async action that pages rows from SQLite and writes a file before sharing. |
| Diagnostics reintroduce giant text | Automatic `queueTextArtifact()` of the full transcript recreates the same giant-blob behavior after stop or recovery. | Remove transcript-text artifacts from routine stop/recovery flows in this batch. |
| Old interrupted meetings | Existing recovered rows may still only have `meetings.transcript` plus segment files. | Recovery UI and export must support both legacy-blob and new block-backed meetings. |
| Live-screen memory drift | A `FlashList` alone is not enough if the record screen still owns the entire transcript string. | The record screen keeps only the current draft block plus a capped recent window. |
| Low storage mid-run | A long recording can succeed for most of the meeting and then fail while closing audio, exporting, or retrying transcription. | Add free-space checks, durable low-storage diagnostics, and cleanup rules that prefer deleting old staging artifacts before risking the active meeting. |

### Test and release additions required in the same batch

| Test area | Exact additions |
|---|---|
| Transcript chunking | Add new Vitest coverage for block overlap merge, draft finalization thresholds, and timestamp propagation. |
| Storage/export | Add Vitest coverage for block ordering, legacy fallback shaping, and incremental `.md` / `.txt` formatting. |
| Diagnostics redaction | Extend existing diagnostics payload tests so transcript text is not emitted through the structured event lane. |
| Storage pressure | Add tests for retention ordering, active-meeting protection, and low-space preflight decisions. |
| Release guard | Extend `scripts/verify-release.sh` so the release gate fails if transcript surfaces still render through `ScrollView` or if the hot path still queues full transcript text artifacts automatically. |
| Pixel protocol | Replace the current short protocol with a release-mode 3-hour soak covering lock-screen capture, repeated open/close of the app, export, interrupted recovery, and one microphone-route transition. |
| Battery/perf evidence | Capture a comparable armed-idle sample and a recording sample for CPU, battery, and memory so builds can be judged against a baseline rather than feel. |

### One-batch implementation checklist

1. Add the new transcript-block migration and repository helpers without deleting the legacy transcript column.
2. Move live capture writes from `meetings.transcript` to the block repository with one mutable draft block.
3. Replace the meeting-detail transcript `ScrollView` with a paged `FlashList` viewer and explicit file export/share.
4. Add a lightweight recovery screen and route interrupted meetings there first.
5. Remove routine full-transcript artifact uploads from stop/recovery flows; keep structured run summaries and audio/debug artifacts separate.
6. Add free-space preflight, staging cleanup controls, and active-meeting-safe retention behavior.
7. Add service-owned durable diagnostics for long recordings, including recording-state heartbeats and route/memory/process breadcrumbs.
8. Extend the release verifier and add the new transcript/storage/diagnostics unit coverage.
9. Build only after all of the above is implemented together, then run the release-mode Pixel QA gate with battery/performance evidence.

## v0.9.3 — permanent remote ownership and battery hardening

| Requirement | Built | Automated evidence | Pixel evidence |
|---|---:|---:|---:|
| AB Shutter works without ADB/Key Mapper bridge | Yes | Native service, manifest and matcher gates | Pending installed screen-off test |
| Physical Pixel volume keys remain normal | Yes | Strict external device matcher | Pending physical test |
| Hollyland consumer-control HID is rejected | Yes | Native matcher unit test | Pending later USB test |
| Upper toggles; lower stops without 420 ms delay | Yes | Native key mapping compile | Pending physical test |
| Duplicate native delivery cannot create duplicate commands | Yes | 300 ms native emission guard | Pending physical test |
| Supabase shows dispatch and JS acknowledgement | Yes | Native/Expo bridge compile | Pending live upload |
| Always-on listener does not keep React Native awake | Yes | Dedicated `:remote_control` process + release manifest gate | 0.16% CPU over 30 s versus 5.35% before isolation |
| Idle cleanup/Settings polling removed | Yes | Source/test gates | 0.16% remote-listener CPU soak passed; full armed soak pending visible launch |
| Routine logs batched; errors remain prompt | Yes | Native scheduler/JS outbox gates | Pending WorkManager inspection |
| Audio compression deferred until finalization | Yes | Native queue/scheduler separation | Pending recording test |
| One process-wide diagnostics SQLite helper | Yes | Native compile | Pending WAL log inspection |

## v0.9.3 pre-release Pixel evidence

- In-place profiling updates retained `ceDataInode=34106` and the original install time (`2026-08-17 22:34:22`).
- Maina Accessibility bound successfully as `Maina remote control` with no UI-event subscription and Key Mapper disabled.
- A 35.36-second screen-off sample before process isolation measured 5.35% of one CPU core, entirely on the full app's main thread.
- After moving only the accessibility listener to `:remote_control`, a 30.38-second screen-off sample measured 0.16% of one CPU core, a roughly 97% reduction.
- The isolated listener repeated at 0.16% CPU over 30.55 seconds; the final post-status-fix APK consumed zero scheduler ticks over a 15.37-second screen-off sample and produced no crash.
- Final `npm run verify:release` passed: 22 TypeScript tests, three native matcher tests, TypeScript, ESLint, dependency checks, Expo Doctor 21/21, production export, Kotlin/app compilation, and manifest gates.
- Final in-place ADB update retained `ceDataInode=34106`, the original install time and microphone permission; package manager reports `0.9.3 (19)`.
- Final signing certificate SHA-256 remains `4715df74d9a72125848ea45c0f15d2d2e75f25ada4203a406c390be0aac443b4`; APK SHA-256 is `81f36ae9e85e27e0c651eaf2a88c3fd3dc64fad8b87908eeb924061e02c4d3f2`.
- The temporary shell-profiling manifest flag is forbidden by the release verifier and is absent from the final APK.
- Supabase contains the pre-fix cleanup rollback event; the corrected atomic cleanup and native build-number fallback require the next unlocked app launch to produce live post-fix evidence.

## v0.9.2 — remote ownership hotfix

| Requirement | Built | Automated evidence | Pixel evidence |
|---|---:|---:|---:|
| A completed/hidden recorder cannot swallow the next Start | Yes | Focus-scoped ownership + TypeScript/release gates | Pending two-meeting remote test |
| Granted microphone permission does not block background start on Activity resume | Yes | Non-interactive permission preflight | Pending off-screen click retest |
| Remote command records state, command and resolved action | Yes | TypeScript compile | Pending Supabase event check |
| POPIO screen-off testing without Key Mapper action execution | Temporary adapter | ADB shell bridge syntax/device identity gate | Pending locked-screen press test |
| Temporary clicker bridge survives remote sleep/reconnect | Yes | Dynamic evdev discovery + bounded event reads | Verified locked-screen start/stop on build 18 |
| Suppress POPIO's underlying volume action while off-screen | No | Android 17 Audio Hardening rejects ADB-shell correction | Deferred to native/accessibility input owner |
| Production-grade reboot-persistent POPIO bridge | No | Key Mapper upstream screen-off defect confirmed | Deferred: native/Shizuku companion decision |

Deferred after the testing release: replace the temporary shell bridge, add native command acknowledgement/timeouts, add boot/re-arm recovery, and run the full multi-hour/mic-route acceptance protocol.

Temporary bridge lifecycle: `scripts/maina-button-bridge.sh` runs only as Android's shell user, reads the exact `AB Shutter3` evdev node, sends Maina's explicit package broadcasts, writes no meeting content, and intentionally stops at reboot. It must not be presented as the final remote architecture.

## v0.9.2 release evidence

- `npm run verify:release`: passed (22 unit tests, TypeScript, ESLint, Expo dependency check and Expo Doctor 21/21).
- Local EAS hotfix build: passed; app version `0.9.2`, Android version code `18`; no Expo cloud worker or build credit was used.
- Sentry source maps: uploaded for `com.divay.maina@0.9.2+18`, distribution `18`.
- Signing gate: APK certificate SHA-256 remains `4715df74d9a72125848ea45c0f15d2d2e75f25ada4203a406c390be0aac443b4`.
- In-place ADB update: passed; existing app data was retained and package manager reports `0.9.2 (18)`.
- Off-screen logs on build 17 proved the command arrived but an Activity-bound permission request delayed capture until resume; build 18 contains the non-interactive permission preflight correction.
- Locked-screen physical start and stop passed on build 18: command received, meeting created, offline recognizer/audio capture ready, audio closed and meeting saved without opening Maina. The short test produced zero transcript words, so a spoken sample remains pending.

## v0.9.1 — reliability and remote control

| Requirement | Built | Automated evidence | Pixel evidence |
|---|---:|---:|---:|
| Open once after reboot/update, then remain armed | Yes | Native Kotlin compile + manifest gate | Pending unlock/open-once test |
| Settings shows armed, notification, input-device and last-press status | Yes | TypeScript compile | Pending |
| Primary click starts / pauses / resumes | Yes | State-table unit tests | Pending |
| Double-primary stops and saves | Yes | Native gesture implementation compiles | Pending |
| Secondary shutter button stops and saves | Yes | Native key mapping compiles | Pending key-code capture |
| Genuine Bluetooth media buttons work while locked | Yes | MediaSession native compile | Pending |
| POPIO works while Maina is visible | Yes | Activity HID bridge compile | Pending |
| POPIO works screen-off through optional Key Mapper Expert Mode adapter | Adapter endpoint built | Manifest command-receiver gate; official Key Mapper v4.3.1 FOSS installed from checksum-verified GitHub release | Pending Expert Mode setup |
| Pause closes a recoverable WAV; resume opens a new segment | Yes | Event-driven TS flow compiles | Pending |
| Stop waits for recognizer end and audio-file close | Yes | TypeScript compile | Pending |
| Hollyland removal rotates immediately to a clean fallback session | Existing v0.9 path retained | TypeScript/native compile | Pending repeat test |
| Hollyland return rotates at a safe boundary | Existing v0.9 path retained | TypeScript/native compile | Pending repeat test |
| Incremental WAV survives process death without stop-time whole-file copy | Existing v0.9 patch retained | Patch inspection + compile | Pending force-stop test |
| Supabase events cannot be blocked by audio uploads | Yes | Separate WorkManager lanes compile | Pending live upload |
| Nullable Expo bridge failure removed | Yes | Null-free native maps + payload compaction compile | Pending live upload |
| Seven-day / 3 GiB rolling recovery policy | Existing v0.9 path retained | Store tests by code review | Pending retention soak |
| Local authoritative Hinglish model | No | Model bake-off disproved generic auto/forced language | Future gated release |
| Speaker diarization | No | Timestamp-compatible architecture only | Future gated release |

## Release gates

1. `npm run verify:release` passes.
2. Release APK is signed with the same certificate as the installed app.
3. `adb install -r` succeeds without deleting app data.
4. Supabase receives a v0.9.1 launch event within two minutes.
5. The Pixel protocol in `docs/TEST_PROTOCOL_v0.9.1.md` passes.

No claim moves from “Pending” to “verified” without retained evidence in logs, ADB output, or an automated test.

## v0.9.1 release-candidate evidence

- `npm run verify:release`: passed (22 unit tests, TypeScript, ESLint, Expo dependency check, Expo Doctor 21/21, production JS export, Kotlin module/app compilation, and merged-manifest assertions).
- Local EAS release build: passed; app version `0.9.1`, Android version code `14`; no Expo cloud worker was used.
- Sentry source maps: uploaded for `com.divay.maina@0.9.1+14`, distribution `14`.
- Signing gate: new and installed APK certificate SHA-256 both equal `4715df74d9a72125848ea45c0f15d2d2e75f25ada4203a406c390be0aac443b4`.
- In-place ADB update: passed; existing app data was retained and package manager reports `0.9.1 (14)`.
- Launch crash smoke: passed; no fatal exception or Android Runtime crash was observed.
- Armed-service/remote/Supabase gates: pending the required first unlock and visible launch after update.
