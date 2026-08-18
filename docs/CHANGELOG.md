# Changelog

All notable changes to Maina are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

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
