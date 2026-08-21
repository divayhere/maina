# Changelog

## 0.10.0 — qualified native-Qwen capture pipeline

- Fold ASR tails of five seconds or less into the preceding 25-second window. This avoids false incomplete-coverage results from decoding overlap/noise as a standalone tiny clip while keeping every default decode at or below 30 seconds.

## 0.9.9 — app-storage Qwen loading

- Initialize sherpa-onnx through its documented file loader when Qwen model files live in app storage. Passing Android's asset manager caused sherpa to treat absolute paths as APK asset names and terminate the process.

## 0.9.8 — device-verified local ASR handoff

- Fixed the native WAV duration parser to accept both `file:/...` and `file:///...` URIs. The former is emitted by Java `File.toURI()` and previously caused valid finalized audio to produce zero ASR windows.
- Added native regression tests for Java, Expo, and plain-path capture file formats.

## 0.9.7 — acknowledged capture and bounded local ASR

- Makes native start, pause, resume, and stop observable state transitions; the UI now waits for the recorder service to acknowledge each command.
- Moves blocking WAV finalization off Android's service main thread and prevents transcription from racing an unfinished `.partial` file.
- Adds crash recovery for durable partial WAVs and registers recovered native chunks with the existing meeting-recovery flow.
- Processes finalized audio through 25-second Qwen windows with one-second analysis overlap instead of sending ten-minute files to a bounded decoder.
- Reuses one sherpa-onnx recognizer across a meeting, reads only the requested PCM window, validates the exact model pack, and releases model memory after processing.
- Accounts for every ASR window, records audio levels/token limits, withholds automatic summaries when coverage is incomplete, and keeps the original audio available for retry.
- Routes native saved-audio retries through the same modular local-ASR pipeline; legacy recordings retain their compatibility path.

## [Unreleased] — capture-first ASR staging

### Added

- ADR 0009 defining service-owned capture, immutable audio, model-neutral
  local-ASR interfaces, and audio-source calibration.
- ASR adapter contract and deterministic coverage/repetition quality checks.
- Isolated native PCM/WAV capture component with periodic sync, finalized WAV
  headers, atomic chunk finalization, and an append-only recovery journal.
- Official sherpa-onnx Android runtime dependency for the Qwen qualification
  path. Qwen model data is intentionally not included in the APK.
- Native-Qwen staging path is now wired behind the recorder entry point:
  Maina captures durable WAV chunks first, then runs local Qwen transcription
  after stop/save. This deliberately removes live ASR from the recording hot
  path so recognition cannot interrupt audio capture.
- Release-mode Android staging APK was built locally and installed on the Pixel
  over ADB without using Expo cloud build credits. The Qwen model pack was
  pushed outside the APK to app-specific external storage.

### Not yet enabled

- First end-to-end Pixel recording proof is still pending. App launch is clean,
  model files are present, and automated/native compile gates pass, but the
  first real record → stop → Qwen transcript run must still be tested through
  the app UI/clicker.

## [Unreleased]

### Added
- Timestamped `transcript_blocks` storage for new and reprocessed meetings, with paging helpers, summary counts, and a future speaker-diarization seam.
- A lightweight interrupted-meeting recovery route that opens before large transcript content is mounted.
- Maintainer-facing storage diagnostics, retained-audio visibility, and staging cleanup / diagnostics purge controls.
- A stricter local release verifier that fails if the meeting detail screen regresses to unsafe full-transcript rendering or if hot paths resume automatic giant transcript artifact uploads.
- Auto-generated meeting packets with summary, decisions, open questions, and structured to-dos from a user-selected AI provider.
- Persisted AI provider settings for Gemini, OpenAI, Anthropic, Grok, DeepSeek, and custom OpenAI-compatible endpoints.
- A global to-do surface and per-meeting packet metadata, plus a temporary audio-retention policy that keeps transcripts but prunes old audio.

### Changed
- The live record screen now keeps only a small recent transcript tail plus a single mutable draft block instead of one ever-growing transcript string in React state.
- Meeting detail now uses `FlashList` paging and async export/share helpers rather than rendering the entire transcript in one `ScrollView`/`Text` tree.
- Routine stop/recovery flows no longer queue the entire transcript as a diagnostics text artifact.
- Native diagnostics now report service heartbeats, retained audio bytes, and free storage without carrying transcript/audio content.
- Meetings, settings, and to-dos now use a packet-first product flow: Overview before Transcript, one Markdown share path, and automatic post-meeting packet generation.

### Verification
- `npm run typecheck`, `npm test`, and `npm run lint` pass locally.
- The latest packet-first/UI code still needs one fresh full `bash scripts/verify-release.sh` completion after this batch's final polish pass. Earlier transcript-safety foundations had already passed the local release verifier.
- No APK was built from this batch yet.

## 0.9.6 — reliability hardening for daily beta use

- Hardened the patched native WAV recorder so a missing or changing meeting folder can no longer crash Maina during stop/save teardown.
- Tightened discard/cancel teardown to wait for the active audio file to close before deleting local meeting artifacts.
- Made external mic route loss recover faster and surface a clear in-session note when Maina switches back to the phone mic or refreshes an external route.
- Added diagnostics readiness/queue visibility at launch and recording start, plus an explicit diagnostics flush after save/cancel so session evidence leaves the phone sooner.

### Verification

- `npm run typecheck`, `npm test`, `npm run lint`, `bash scripts/verify-release.sh`
- Native Android compilation: `:maina-recorder:testDebugUnitTest`, `:maina-recorder:compileDebugKotlin`, `:app:compileDebugKotlin`

## 0.9.3 — permanent locked-screen control and idle efficiency

- Replaces the temporary ADB input bridge with a narrowly scoped Android Accessibility Service that accepts only the dedicated AB Shutter remote.
- Uses stable remote identity instead of volatile `/dev/input/eventN` paths, consumes the remote key event, and leaves the Pixel's physical volume controls untouched.
- Isolates the always-on key listener from React Native and diagnostics work so the full app can sleep while the phone is locked.
- Adds command IDs, native duplicate suppression, acknowledgements, and locked-screen readiness to Settings and remote diagnostics.
- Removes idle polling for audio cleanup and Settings status; recording watchdog checks back off while backgrounded or paused.
- Batches routine diagnostic events, sends warnings/errors promptly, defers artifact compression until meeting finalization, and avoids repeated diagnostics SQLite WAL open/close cycles.
- Fixes audio-retention state reconciliation to use one atomic SQL update instead of a nested transaction that could fail during app backgrounding.

## 0.9.2 — reliable remote ownership

- Avoids an Activity-bound microphone permission request when permission is already granted, so an armed background click can continue into capture instead of waiting for Maina to be opened.
- Makes only the currently focused recording screen own pause, resume and stop commands.
- Returns command ownership to the root controller after saving or leaving a meeting, preventing an invisible old recorder from swallowing the next Start command.
- Logs the resolved remote state, command and action for direct diagnosis.
- Keeps the POPIO screen-off bridge as a temporary ADB testing adapter; Key Mapper screen-off execution is not treated as production-ready.

## 0.9.1 — armed control and observable recovery

- Keeps a native foreground control service armed after opening Maina once.
- Adds MediaSession, notification and explicit-intent controls for locked-screen remotes.
- Maps primary click to start/pause/resume, double-primary to stop, and common secondary shutter keys to stop.
- Adds pause/resume with event-driven WAV finalisation and a new segment on resume.
- Adds Settings readiness, notification, connected-input and last-command status.
- Splits Supabase events, artifacts and retention into independent WorkManager lanes.
- Removes nullable values at the Expo/Kotlin bridge that blocked v0.9 diagnostics.
- Adds a versioned implementation ledger, Pixel acceptance protocol and automated release verifier.

All notable changes to Maina are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

## [0.9.0] — Transcription trust, hardware trigger and recovery

### Added
- Foreground support for generic OS-paired Bluetooth HID shutter remotes. Common Android/iOS shutter key codes toggle recording without changing phone volume.
- Native active-recording-route diagnostics: actual input device, source, client/actual formats, channel count and silenced state.
- USB microphone add/remove events with controlled recognizer segment rotation, reducing the long automatic Android fallback delay.
- ASR quality telemetry for final/partial results, confidence samples, detected Hindi/English and successful/failed Android language switches.

### Fixed
- Upload transcript artifacts before audio and isolate failures so a slow/broken encoder cannot block the transcript.
- Use stable 32 kbps AAC-LC/M4A first on the Pixel, retaining Opus as fallback after the measured Opus stall.
- Send native artifact exception, path, existence, bytes, attempt, meeting and segment evidence to Supabase.
- Keep recoverable source audio for seven days with a 3 GiB oldest-safe-first cap and 5 GiB phone-free-space floor; never evict active, failed, incomplete or unsynced meetings.
- Preflight every saved-audio file before re-transcription and hide the stale action instead of making three doomed `audio-capture` attempts.
- Treat Android's client error emitted during an intentional stop as an acknowledgement rather than a recording failure.
- Throttle low-value language-detection noise while retaining actual switch decisions.

### Verification
- TypeScript, 15 unit tests, ESLint and all 21 Expo Doctor checks pass.
- Clean Expo prebuild passes and the generated Kotlin `MainActivity` contains the HID bridge.
- Both `maina-recorder` and the complete release app compile successfully against Android SDK 36/Kotlin 2.1.20 using project-local tooling.
- Physical Pixel validation remains required; see ADR 0007.

## [0.8.1] — Diagnostics reliability correction

### Fixed
- Drain every queued diagnostic artifact and expired remote object in bounded batches instead of stopping after the first four/twenty records.
- Close the diagnostics database even when remote delivery is disabled or not configured.
- Measure audio-active time, recognizer downtime, restart gaps, failed files and the largest observed gap from lifecycle events instead of copying meeting wall time or reporting placeholder zeroes.
- Add a real v1→v2 native diagnostics database migration and reject unknown future migration paths.
- Abort a stalled/overlong native audio encode and remove incomplete output instead of allowing a WorkManager job to hang indefinitely.
- Remove the misleading recording notification claim that audio always stays on the phone while development backups are enabled.

### Added
- Queue age, last failed attempt, exhausted retry count and a manual “Retry failed uploads” action in System Status.
- Pure unit tests for recording-health measurements.
- Runtime Sentry crash/ANR reporting for organization `divayhere`, project `maina-android`. Source-map upload remains pending a separately stored Sentry auth token.

### Verification
- TypeScript, ESLint and 15 unit tests pass.
- A clean Android Expo prebuild passes. A temporary JDK was used without changing the Mac, but native Kotlin compilation remains pending because no Android SDK is installed locally.
- No EAS build was submitted.

## [0.8.0] — Durable observability and automatic bilingual setup

### Added
- A native SQLite diagnostic outbox drained by Android WorkManager, so events survive process death and upload when connectivity returns.
- Append-only Supabase event/run/artifact tables with anonymous insert-only RLS and a private seven-day diagnostic artifact bucket.
- Native WAV compression to 32 kbps Opus/Ogg, with 48 kbps AAC fallback, before diagnostic upload.
- Deterministic artifact IDs, SHA-256 metadata, bounded retries, periodic phone-driven remote expiry, and source-WAV deletion only after the transcript and every compressed segment are confirmed uploaded.
- Recovery upload for WAV segments left behind by an app/process interruption.
- Optional Sentry crash capture; it remains disabled until a DSN is configured.

### Changed
- Indian English and Hindi offline packs are provisioned automatically. Recording chooses the best installed core model and enables a tightly limited `en-IN`/`hi-IN` code-switch set for Hinglish.
- Removed the manual transcription-language picker. Settings now reports readiness instead of asking the user to manage models.
- Replaced the copy/paste diagnostic dump with a compact queue, upload, model, input and error status screen.

### Fixed
- Android language allowlists are now sent as `ArrayList<String>`, matching `RecognizerIntent` rather than a generic array extra.
- Language-detection logs now include Android's actual switch result and result code instead of treating every noisy detection candidate as a successful switch.

### Verification
- TypeScript, ESLint and unit tests pass.
- A clean Expo prebuild and native Android Kotlin compilation pass locally. No EAS build was submitted.

## [0.7.0] — Durable background recording release candidate

### Added
- A real Android `microphone` foreground service with an ongoing recording notification for screen-off/background capture.
- Native audio-input inventory in Diagnostics so USB-C/Bluetooth routing can be checked from logs.
- Per-audio-file SQLite checkpoints, interruption recovery metadata, transactional/idempotent migrations, and WAV repair on next launch.
- Full transcript copy and Markdown sharing.
- Vitest transcript-boundary tests plus working TypeScript and ESLint quality gates.

### Fixed
- Declared the local recorder module's Android version metadata so Expo SDK 57 autolinking can configure release builds.
- Replaced `expo-speech-recognition`'s stop-time whole-file `readBytes()` WAV conversion with incremental disk writing. WAV headers are checkpointed every five seconds, avoiding multi-hour heap spikes and making abrupt-kill recovery possible.
- Audio files rotate every 10 minutes (~19.2 MB at 16 kHz mono) instead of relying on one unbounded file or 30-second transcription jobs.
- Stop now waits for the recognizer `end` event with a bounded timeout, retaining the last partial and removing the fixed 700 ms race.
- Transcript checkpoints now run every five seconds even when Android has not emitted a final result.
- Saved-audio re-transcription retries failed files and never silently skips one.
- On-device speech now fails closed: no silent network recognizer fallback.
- Database startup failures now show a safe retry screen instead of opening a broken app.

### Security
- Disabled Supabase remote logs until anonymous SELECT is removed from `device_logs`.
- Removed the embedded legacy Supabase key from source and redacted sensitive log context.
- Disabled Android Auto Backup for meeting audio/database data.

### Known limits
- Android explicitly does not guarantee `SpeechRecognizer` for continuous recognition; multi-hour device testing remains mandatory.
- Speaker diarisation, AI summaries/to-dos, and the physical Bluetooth trigger are not included in this release.

## [0.6.0] — Robustness pass (validated against reported bugs)

### Added
- **Never lose a meeting**: the meeting row is created when recording starts and the transcript is saved every 5s and on backgrounding. A crash/kill loses at most 5 seconds.
- **Crash recovery**: meetings left mid-recording are recovered on next launch.
- **Stall watchdog**: if no recogniser event arrives for 30s, force a restart (covers the silent-death-on-phone-call bug, upstream #135).
- **Restart debounce** + longer delay after ERROR_RECOGNIZER_BUSY.
- **Real audio paths** captured from the audioend event instead of assumed.
- **Keep-awake** while recording so the screen cannot sleep mid-meeting.

See docs/decisions/0004-native-speech-architecture.md for the full validation and risk register.

## [0.5.0] — Live transcription (Whisper removed) via the phone's own speech engine

### Changed (major)
- **Primary engine is now Android on-device SpeechRecognizer** (expo-speech-recognition) instead of Whisper. Text appears **live as you speak**, free forever, offline, using the phone's speech hardware. Whisper on the CPU measured ~6x slower than realtime, degrading to 65 min for a 30 s segment (thermal throttling + decoder retry loops on quiet audio).
- **Hinglish**: EXTRA_ENABLE_LANGUAGE_SWITCH lets the recognizer switch Hindi<->English mid-sentence. Language picker + one-tap offline language pack download in Settings.
- **Sessions auto-restart** when Android ends one, so long meetings stay continuous; each session persists its own audio file into the meeting folder.
- **Whisper removed entirely** — it could never be real-time on a phone CPU, and the small models are weak at Hindi. Removed whisper.rn, the PCM recorder, expo-audio and the buffer polyfill (4 native deps), shrinking the APK and cutting build risk.
- **Audio kept** as a safety net, with **"Re-transcribe from saved audio"** using the same fast native engine (audioSource), plus a per-meeting **delete audio** action.

## [0.4.0] — Hours-long recording + resumable transcription

### Changed (major)
- **Recording streams to disk as ~30s WAV segments** (bounded memory) — hours-long meetings no longer risk filling RAM. Recording is the source of truth and never waits on transcription.
- **Transcription is now chunked + resumable**: segments transcribed one at a time, transcript + progress persisted per segment; resumes after a crash/reload from the last finished segment.
- **Model = Large v3 Turbo quantized (q5_0, ~547 MB)** — accuracy-with-reliability for Pixel 9 Pro; single local model (picker removed; summariser dropdown kept).
- **Robust model download**: temp file → verify size → move into place; partials deleted. Fixes the corrupt-partial retry loop. Pre-download button in Settings.

See docs/decisions/0003-hours-long-pipeline.md. DB migration v3.

## [0.3.4] — Model picker (fix Hindi)

### Added
- In-app **model picker** (Settings → Transcription model): Base / Small / Medium / Large v3 Turbo. Bigger models transcribe Hindi far better; each downloads on first use. Selection persists (SQLite settings table).
- whisper threads 4→6 for faster large-model transcription.

### Why
- Logs showed the base model detected Hindi but produced ~8 chars — too weak for Hindi. Default is now **Small**; try Medium/Large for best Hindi.

## [0.3.3] — Fix: recordings now actually save audio

### Fixed
- The PCM library only *streams* audio chunks (its `wavFile` option is ignored on Android) and its `stop()` returns nothing — so recordings had no audio file (`hasAudio:false`) and couldn't be transcribed. Now we collect the streamed PCM chunks and assemble a proper 16 kHz mono WAV ourselves. Diagnosed live via the Supabase log stream.

## [0.3.2] — Live remote monitoring

### Added
- **Supabase remote log stream** enabled: every structured log entry flows to a `device_logs` table (RLS-protected, anon insert/select), letting the maintainer watch the app in near real time and diagnose without the user describing anything.

_Includes everything from 0.3.1 (the whisper `file://` fix + on-device Diagnostics)._

## [0.3.1] — Transcription fix + Diagnostics

### Fixed
- Pass whisper.cpp a plain filesystem path (strip Expo's `file://`) for both the model and the audio — the likely cause of transcription not running.

### Added
- **Diagnostics screen** (Settings → Diagnostics & logs): shows the in-app log, survives crashes (persisted to disk), and a **Share logs** button so issues can be sent without guesswork.
- **Watchdog**: global JS-error capture + error boundary (calm recovery card instead of a white crash).

## [0.3.0] — Phase 2: On-device Transcription

### Added
- **Whisper on-device transcription** (whisper.rn): tap **Transcribe** on a meeting → model downloads once (~148 MB, base multilingual) → transcript generated fully offline. English, Hindi, and Hinglish.
- **16 kHz mono WAV capture** via `@fugood/react-native-audio-pcm-stream` (replaces expo-audio recording; whisper-ready with no transcoding).
- **Audio auto-deletion** after a transcript is saved (privacy; config-controlled).
- Transcription engine behind the `TranscriptionEngine` swap-seam; model registry (base / small); download-with-progress UI.
- `buffer` polyfill for whisper.rn's safe-buffer dependency.

### Changed
- Meeting detail shows live download %/transcribing state, the transcript, and an "audio deleted" indicator.

See `docs/decisions/0002-audio-pipeline.md`.

## [0.2.0] — Phase 1: Record → Save

### Added
- **Real audio recording** (expo-audio): tap record → live timer → Stop & Save. Mic permission handled; records from the phone microphone.
- **Meetings home**: list of recordings (title · date/time · duration · status chip), empty state, floating record button.
- **Meeting detail**: metadata, audio-captured indicator, and Transcript/Summary placeholders (Phase 2/3).
- **To-Dos & Settings tabs**: Settings shows version, provider default, and config; To-Dos stubbed for Phase 3.
- **SQLite storage** with a versioned migration runner + meetings repository.
- **Zustand** meetings store; Electric Grape theme applied via shared UI kit.

### Notes
- Audio is kept for now; auto-deletion lands with Phase 2 transcription.
- Background/foreground-service recording hardening comes in a later phase; v0.2 records with the app open.

## [Unreleased]

### Added
- Project scaffold: Expo SDK 57, React Native 0.86, React 19, TypeScript, Expo Router.
- Modular architecture skeleton (see `docs/decisions/0001-foundations.md`):
  - Swap-seam interfaces for transcription engine and AI summarizer.
  - Hardware isolation interfaces for mic source and trigger (button).
  - Electric Grape design tokens (light + dark).
  - Structured logger + watchdog scaffold (Sentry-ready).
  - App config / feature flags module.
  - Multi-provider AI registry: Gemini, OpenAI (ChatGPT), Anthropic (Claude), Grok, DeepSeek.

### Build
- **APK 0.1 produced via EAS** (Android, internal/preview, cloud keystore). Pipeline proven end to end: local code → GitHub → EAS cloud build → installable APK.

_This is Phase 0. No feature behaviour yet — the goal of 0.1 was: installs, opens, pipeline proven. ✅ Achieved. Next: Phase 1 (record → save)._
