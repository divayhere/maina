# ADR 0001 — Foundations & locked decisions

Status: **Accepted** · Date: 2026-08-17

This record exists so future sessions do not re-litigate settled calls. Update it, don't contradict it silently.

## Product

- **What it is:** a personal, click-to-record meeting recorder. Hardware button → capture → on-device transcript → summary + to-dos. Replaces Fireflies + AI-wearable necklaces. Personal use, not public.
- **Working name:** Maina (the talking Indian mynah bird).

## Platform

- **Target device: Pixel 9 Pro (Android only).** Reason: iOS blocks background mic recording for normal apps, blocks the Bluetooth button path, has no free-forever sideloading (7-day resign), and Web Bluetooth is unsupported. Android removes all of these walls.
- **Form factor: native app (Expo + React Native), NOT a PWA.** A PWA cannot do background recording, Bluetooth HID, or run Whisper well.
- **Distribution:** private APK via EAS Build. No Play Store / no Apple Developer account.

## AI core (the swap-seams)

- **Transcription: on-device Whisper via `whisper.rn`** (whisper.cpp). Model default: large-v3-turbo (multilingual: English + Hindi + Hinglish code-switching). **Swappable** behind `TranscriptionEngine`.
- **Summaries + to-dos: cloud LLM, user's own API key.** Transcript text leaves the device; **audio never does**. **Multi-provider** behind `Summarizer` + a provider registry: Gemini (default, free tier), OpenAI/ChatGPT, Anthropic/Claude, Grok, DeepSeek — user adds keys and picks per provider.
- **Privacy line:** audio auto-deleted the instant the transcript is saved (toggle to keep). Cloud summaries acceptable to the user.

## Hardware

- **Mic:** any mic works (app records from the OS default input). Recommended: Hollyland Lark M2 (2TX + USB-C receiver) for multi-voice room capture; USB-C keeps Bluetooth free for the button. Quality bar = "good enough for an LLM to transcribe," not broadcast.
- **Button:** must connect **directly to the phone** (BLE HID or Flic SDK). Smart-home buttons (Aqara/Tapo) rejected — they need a hub and won't work in a meeting room. Start with a generic BT camera-shutter clicker (HID keypress); Flic 2 as the premium upgrade. **Swappable** behind `TriggerSource`.
- Until hardware arrives, development uses the **phone mic + an on-screen record button**.

## Engineering

- **Modularity:** sealed compartments with frozen interfaces; implementations swap freely. Purple swap-seams: transcription model, AI provider, mic source, trigger, design tokens.
- **Never lose a meeting:** audio + transcript written to disk as they go; partials survive crashes.
- **Watchdog:** Sentry (crash/error dashboard the maintainer reads) + rolling local log with one-tap export + error-boundary safety-net UI. User should never have to describe a bug.
- **Versioning:** SemVer, `docs/CHANGELOG.md`, ADRs, git tags, in-app version/build shown in Settings → About.

## Design

- **Direction:** Apple-calm bones (whitespace, one thing per screen, big targets, system font, soft rounded cards, spring motion) + Gen-Z spark (bold signature accent, expressive title font, alive record state, haptics, human copy).
- **Palette: Electric Grape** — violet `#6C4CE0`, soft lilac `#B7A6F5`, near-white `#F2F1F8`, ink `#1C1830`.

## Build phases

0 Foundations/toolchain → 1 Record+save → 2 On-device transcription → 3 Summaries+to-dos → 4 Hardware (button+mic) → 5 Polish+watchdog+battery. Each phase ships a testable APK.
