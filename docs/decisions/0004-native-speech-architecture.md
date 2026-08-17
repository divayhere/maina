# ADR 0004 — Native speech engine: validation, risks, and the plan

Status: **Accepted** · Date: 2026-08-18 · Version: 0.6.0

## Why we changed engines

Measured on the Pixel 9 Pro with Whisper (whisper.rn, large-v3-turbo q5_0):

| Audio | Time | Output |
|---|---|---|
| 15 s Hindi | 90 s | 160 chars |
| 30 s | 190 s | 13 chars |
| 30 s | 29 min | 10 chars |
| 30 s | 65 min | 10 chars |

Root causes: (1) **q5_0 quantization is 3–5.5× slower than q4_0** (my error); (2) whisper.cpp on Android is **CPU-only** — the Tensor NPU is unused; (3) sustained load → **thermal throttling**, plus Whisper's **temperature-fallback retry loops** on quiet audio (huge time, ~10 chars out).

Conclusion: Whisper-on-phone-CPU can never be real-time. Apple Dictation / Google Recorder use the **OS speech engine on dedicated hardware**; Otter/Fireflies use **cloud streaming ASR**. We now use the former.

## Architecture

```
Record screen
  └─ expo-speech-recognition (Android SpeechRecognizer, com.google.android.as)
       continuous: true            → EXTRA_SEGMENTED_SESSION + custom audio source
       requiresOnDeviceRecognition → offline, free, NPU-backed
       recordingOptions.persist    → WAV per session, kept as a safety net
       EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced' → Hindi↔English mid-sentence
  └─ finals accumulated → throttled save to SQLite (every 5 s)
  └─ session ends (any cause) → auto-restart → keeps one continuous meeting
```

**Swap-seam:** `src/core/transcription/nativeSpeech.ts` is the only module that knows the engine. Replacing it does not touch UI, DB, or summarisation.

## Crowd validation — what the ecosystem reports, and our position

Sources: library GitHub issues, whisper.cpp discussions, Android docs, developer write-ups.

| Reported problem | Evidence | Our position |
|---|---|---|
| Beep on start/stop (hardcoded in SpeechRecognizer) | README | **Avoided** — `continuous` + `persist` both set a custom audio source, which suppresses it |
| Continuous mode is *segmented*; finals must be concatenated | README | **Handled** — we accumulate finals; this is the documented contract |
| Stops after 5–8 s even with `continuous: true` (#98, open) | Issue #98 — reporter used **network** recognition | **Mitigated** — we use on-device + segmented session + custom audio source; plus auto-restart, which is the accepted fix |
| "network" error after N seconds (#131, open) | Reporter used `requiresOnDeviceRecognition: false` | **Likely avoided** — we force on-device; no network path |
| Silent failure on incoming phone call (#135, open) | No error emitted, session dies quietly | **Mitigated** — stall watchdog restarts if no event for 30 s |
| `ERROR_RECOGNIZER_BUSY` on rapid restart | Android docs | **Handled** — restart debounce, longer delay after a `busy` error |
| `getSupportedLocales` double-settle crash (#152) | Closed | On latest version (56.0.1) |
| On-device needs Android 13+ and a downloaded language pack | README | Pixel 9 Pro is fine; Settings has a one-tap pack download + install status |
| Background/screen-off needs a foreground service | Android docs | **Partially addressed** — keep-awake for v0.6; a foreground service is the next step (see Open risks) |

Source reading (`ExpoSpeechService.kt`) confirmed: with Android 13+ and `persist`, the intent uses `EXTRA_SEGMENTED_SESSION` + `EXTRA_AUDIO_SOURCE`, and **any error tears the session down and emits `end`** — so restart-on-`end` is the correct and sufficient recovery hook.

## Robustness added in 0.6.0

1. **Never lose a meeting** — the meeting row is created *when recording starts*, and the transcript is saved every 5 s and on backgrounding. A crash, kill, or dead battery loses at most 5 seconds.
2. **Crash recovery** — meetings left in `recording` state are recovered on next launch.
3. **Auto-restart with debounce** — sessions restart on `end`; longer delay after `busy`.
4. **Stall watchdog** — no recogniser event for 30 s while active ⇒ force stop + restart (covers silent deaths like an incoming call).
5. **Real audio paths** — audio URIs are taken from the `audioend` event, not assumed.
6. **Keep-awake** while recording, so the screen doesn't sleep mid-meeting.

## Open risks (honest)

- **Screen-off / phone-in-pocket** is *not* guaranteed yet. Android may throttle a backgrounded app; a **foreground service** (e.g. notifee) is the proper fix and is deliberately deferred until the core is proven on-device, to keep this build small and low-risk.
- **Far-field accuracy** (phone on a table, several speakers) is unproven; the Hollyland/DJI mic should help materially.
- **Library targets Expo SDK 56; we run SDK 57.** Dependency check, bundling and prebuild all pass, but this is unverifiable until a real build.
- **Restart gaps** — a word spoken exactly during a session restart could be missed. Unknown in practice; measurable from logs (`session restarted` frequency).
- **Speaker labels** are not provided by this engine; diarisation would be a separate feature.

## Verification performed without spending a build

- TypeScript compiles clean (proves every option name matches the library's API).
- JS bundle succeeds.
- `expo prebuild` succeeds; manifest contains `RECORD_AUDIO`, `FOREGROUND_SERVICE_MICROPHONE`, and the `com.google.android.as` package query.
- `expo install --check` reports all dependencies compatible with SDK 57.
- Caught and fixed a stale `expo-audio` plugin entry that **would have failed the EAS build**.

## Next steps after this build is validated on device

1. Confirm Hindi/Hinglish quality and restart smoothness from the Supabase log stream.
2. Foreground service for pocket/screen-off recording.
3. Phase 3 — summaries + to-dos (provider dropdown already built).
4. Bluetooth button trigger.
