# Changelog

All notable changes to Maina are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

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
