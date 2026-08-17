# Changelog

All notable changes to Maina are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

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
