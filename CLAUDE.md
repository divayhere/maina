# Maina — project brief for Claude

Personal, click-to-record meeting recorder for the **Pixel 9 Pro (Android only)**.
Button → durable local audio → best-effort live Android on-device transcript → optional summary + to-dos. Audio is retained until the user deletes it. Replaces Fireflies + AI-wearable necklaces. Not public.

## Read first
- `docs/decisions/0001-foundations.md` — all locked decisions. Do not contradict silently.
- `docs/CHANGELOG.md` — what's shipped. Update on every change.

## Architecture (modular compartments)
Interfaces are frozen; implementations swap freely. Swap-seams:
- `src/core/transcription/` — Android on-device speech wrapper + pure transcript merge logic.
- `src/core/summarization/` — `Summarizer` + `providers.ts` (Gemini default; OpenAI, Anthropic, Grok, DeepSeek).
- `src/hardware/trigger/` — `TriggerSource` (BT shutter clicker / Flic / on-screen).
- `src/hardware/mic/` — `MicSource` (records from OS default; any mic works).
- `src/design/tokens.ts` — Electric Grape palette; restyle here only.
- `src/services/logger.ts` — watchdog log; `src/services/config.ts` — feature flags.

## Rules
- Never lose a meeting: write audio + transcript to disk as they go; partials survive crashes.
- Watchdog first: structured persisted log + error boundary. Sentry is not configured yet.
- SemVer + CHANGELOG + ADRs. In-app version shown in Settings → About.
- Design: Apple-calm bones + Gen-Z spark. Palette Electric Grape (`#6C4CE0`).

## Build
- Expo SDK 57 / RN 0.86 / React 19 / TypeScript / Expo Router.
- APKs via **EAS Build** (cloud) — needs the user's Expo login. No Android Studio required locally.
- `npm run check` is the local quality gate. EAS builds are limited; submit only after it passes and the owner explicitly says build.

## Toolchain notes
- Node installed via Homebrew at `/opt/homebrew/bin` (prefix `export PATH=/opt/homebrew/bin:$PATH` in non-login shells).
- User does not code. Deliver APKs; keep explanations plain. User will run auth commands when needed (Expo/GitHub/Sentry).

@AGENTS.md
