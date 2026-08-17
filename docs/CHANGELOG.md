# Changelog

All notable changes to Maina are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

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
