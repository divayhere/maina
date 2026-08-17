# Maina — project brief for Claude

Personal, click-to-record meeting recorder for the **Pixel 9 Pro (Android only)**.
Hardware button → capture → **on-device Whisper transcript** → **cloud-LLM summary + to-dos** (user's own API key). Audio auto-deleted after transcription. Replaces Fireflies + AI-wearable necklaces. Not public.

## Read first
- `docs/decisions/0001-foundations.md` — all locked decisions. Do not contradict silently.
- `docs/CHANGELOG.md` — what's shipped. Update on every change.

## Architecture (modular compartments)
Interfaces are frozen; implementations swap freely. Swap-seams:
- `src/core/transcription/` — `TranscriptionEngine` (Whisper via whisper.rn).
- `src/core/summarization/` — `Summarizer` + `providers.ts` (Gemini default; OpenAI, Anthropic, Grok, DeepSeek).
- `src/hardware/trigger/` — `TriggerSource` (BT shutter clicker / Flic / on-screen).
- `src/hardware/mic/` — `MicSource` (records from OS default; any mic works).
- `src/design/tokens.ts` — Electric Grape palette; restyle here only.
- `src/services/logger.ts` — watchdog log; `src/services/config.ts` — feature flags.

## Rules
- Never lose a meeting: write audio + transcript to disk as they go; partials survive crashes.
- Watchdog first: Sentry + local log + error boundary. The user should never have to describe a bug.
- SemVer + CHANGELOG + ADRs. In-app version shown in Settings → About.
- Design: Apple-calm bones + Gen-Z spark. Palette Electric Grape (`#6C4CE0`).

## Build
- Expo SDK 57 / RN 0.86 / React 19 / TypeScript / Expo Router.
- APKs via **EAS Build** (cloud) — needs the user's Expo login. No Android Studio required locally.
- Phases: 0 foundations → 1 record+save → 2 transcription → 3 summaries+todos → 4 hardware → 5 polish. Each ships a testable APK.

## Toolchain notes
- Node installed via Homebrew at `/opt/homebrew/bin` (prefix `export PATH=/opt/homebrew/bin:$PATH` in non-login shells).
- User does not code. Deliver APKs; keep explanations plain. User will run auth commands when needed (Expo/GitHub/Sentry).

@AGENTS.md
