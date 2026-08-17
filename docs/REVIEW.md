# Maina — Independent Review Pack

**Purpose of this document:** a self-contained brief for an external reviewer (human or AI) to challenge the product decisions, architecture, and engineering of this app. It states what was built, what was measured, what failed, what was changed, and what is still unproven. Please argue with it.

**⚠️ PARTLY SUPERSEDED — see docs/HANDOFF.md §5.** An independent audit confirmed several claims here are wrong (notably "transcript saved every 5s" and "never lose a meeting"). Read HANDOFF.md first.

**Status:** v0.6.0, code complete and locally verified, **not yet installed on a device.**
**Date:** 18 Aug 2026

---

## 1. What the product is

A personal meeting recorder for **one user**, replacing Fireflies.ai and AI-wearable necklaces (Plaud/Limitless).

Flow: press a button → capture the meeting (in-person or beside a laptop on Google Meet/Teams) → transcript → AI summary + to-dos → searchable history.

**Hard requirements from the owner:**

1. **Zero/near-zero recurring cost.** No monthly subscription. Paying a few rupees per meeting for LLM summaries is acceptable; paying per minute for transcription is not.
2. **Accuracy over speed.** "Time is not a constraint." (But see §7 — this was later contradicted in practice; worth challenging.)
3. **Hours-long continuous recording**, seamless, no breaks. Recording must be the reliable source of truth; transcription may lag and catch up.
4. **Languages: Hindi, English, and mixed (Hinglish)** — a top priority, not a nice-to-have.
5. **Physical Bluetooth button** to start/stop, hands-free. Non-negotiable (this is the "wearable" replacement).
6. **Private.** Audio should not be shipped to third-party servers.
7. **Modular** — the owner expects to swap the AI models/providers over time without breaking everything.
8. **Self-diagnosing** — the owner does not code and should never have to describe a bug.
9. Simple, Apple-like UI with some personality.
10. No Apple Developer account ($99/yr) — refused.

**Devices owned:** iPhone 17 Pro (daily), Pixel 9 Pro (spare, available as the dedicated device).

---

## 2. Platform decision: Android only

**Chosen: Pixel 9 Pro. iOS rejected.** Rationale:

| Requirement | iOS | Android |
|---|---|---|
| Background mic recording | Blocked for normal apps (only CallKit/PushToTalk) | Allowed with a foreground service |
| Bluetooth HID button capture | Heavily restricted | Workable |
| Install without $99/yr account | Sideload expires **every 7 days**; Apple broke SideStore in 26.4 | Plain APK, free forever |
| PWA option | No Web Bluetooth, no background audio | Same limits — PWA rejected on both |

**Also rejected: PWA / Lovable.** A web app cannot do background audio capture, Bluetooth HID, or on-device speech. The owner has a Lovable subscription and initially assumed it could be used; it cannot for this.

**Question for reviewer:** is the iOS dismissal too quick? Is there a legitimate iOS path (e.g. a Shortcuts/Siri integration, or accepting foreground-only recording) that was prematurely discarded?

---

## 3. Hardware

- **Microphone:** recommended Hollyland Lark M2 (2 transmitters + USB-C receiver, ~₹10k). Reasoning: a **conference speakerphone** (Anker PowerConf) captures a room better, but the owner requires something **covert** and battery-powered with a charging case. Two lavalier transmitters give multi-speaker coverage; the **USB-C receiver** is used rather than Bluetooth because (a) DJI documents that Bluetooth-connected mics often fail to feed third-party recording apps on Android, and (b) USB-C keeps Bluetooth free for the trigger button.
- **Button:** must connect **directly to the phone** (BLE HID "camera shutter" clicker, or Flic 2 with its Android SDK). **Smart-home buttons (Aqara, Tapo) were rejected** — they require a hub and cloud round-trip, so they are dead in a client's meeting room.
- Audio quality bar is "good enough for a speech model," not broadcast.

**Not yet purchased or integrated.** All current testing uses the phone's own mic and an on-screen button.

---

## 4. Engineering journey — what was tried and measured

### 4.1 First approach: Whisper on-device (FAILED)

Used `whisper.rn` (whisper.cpp bindings). Recorded 16 kHz mono WAV, transcribed locally.

**Measured on the Pixel 9 Pro** (`large-v3-turbo`, q5_0 quantization, 6 threads, `useGpu: true`):

| Audio length | Time taken | Output |
|---|---|---|
| 15 s (Hindi, close mic) | 90 s | 160 chars — usable |
| 30 s | 190 s | 13 chars |
| 30 s | 132 s | 41 chars |
| 30 s | **29 min** | 10 chars |
| 30 s | **65 min** | 10 chars |

A 4-minute recording processed 3 of 8 chunks in ~2 hours. Earlier, the `base` model produced **8 characters** for a Hindi clip (essentially failure).

**Diagnosed causes:**

1. **q5_0 was the wrong quantization** — benchmarks report 5-bit is **3–5.5× slower than q4_0** with no accuracy gain. This was an implementation error.
2. **CPU-only.** whisper.cpp on Android does not use the Tensor NPU. The dedicated AI hardware sat idle.
3. **Thermal throttling** under sustained 100% CPU across a long run.
4. **Whisper decoder retry loops** on quiet/unclear audio — the signature is huge time for ~10 characters of output. The test audio (a video played into the phone mic) was likely too quiet, triggering this.

**Conclusion drawn:** Whisper-large on a phone CPU cannot be real-time. Apple Dictation and Google Recorder are instant because they use the **OS speech engine on dedicated hardware**; Otter/Fireflies are instant because they **stream to cloud servers**. Running Whisper on-device for live meeting transcription was an architectural mistake.

### 4.2 Current approach: the phone's own speech engine

Switched to **Android's `SpeechRecognizer`** via [`expo-speech-recognition`](https://github.com/jamsch/expo-speech-recognition), configured for Google's on-device service (`com.google.android.as`).

Configuration:
```
continuous: true                    → Android EXTRA_SEGMENTED_SESSION + custom audio source
requiresOnDeviceRecognition: true   → offline, free, hardware-accelerated
interimResults: true                → live partial text as you speak
addsPunctuation: true
androidIntentOptions: {
  EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced'   → switches Hindi↔English mid-sentence
}
recordingOptions: { persist: true, outputDirectory, outputFileName }  → keeps WAV per session
```

Properties: **live** (text appears while speaking), **free forever**, **offline**, **private**, and Google's Hindi model is documented as handling **Hinglish** (mixed) well — which is the owner's top language requirement.

**Whisper was then removed entirely**, along with 4 native dependencies (`whisper.rn`, a PCM streaming lib, `buffer`, `expo-audio`). Rationale: it could never be the fast path; the small/fast Whisper models are *weak at Hindi* so it wasn't even a quality fallback; and its only genuine use (salvaging a failed capture) is covered by the same native engine, which can re-transcribe a **saved audio file** (`audioSource`).

**Safety net retained:** audio is still saved per session, and the meeting screen offers "Re-transcribe from saved audio" using the native engine, plus a manual delete-audio action.

---

## 5. Current architecture

```
UI (Expo Router)
  Meetings list · Record (live) · Meeting detail · To-Dos (stub) · Settings · Diagnostics
        │
Logic
  record flow · (summaries not built yet) · Zustand store
        │
Core  ── SWAP SEAMS ──
  core/transcription/nativeSpeech.ts   ← the only module that knows the speech engine
  core/summarization/providers.ts      ← Gemini / OpenAI / Anthropic / Grok / DeepSeek registry
        │
Data
  SQLite (expo-sqlite) + versioned migrations · meetings repo · settings k/v
        │
Hardware isolation
  hardware/recording/paths.ts  ·  hardware/trigger/* (interface only, not implemented)
        │
Cross-cutting
  structured logger → Supabase remote log stream · error boundary · crash recovery
```

**Stack:** Expo SDK 57, React Native 0.86, React 19, TypeScript, expo-router, expo-sqlite (+ hand-rolled migration runner), Zustand, EAS cloud builds → APK sideloaded to the Pixel.

**Remote diagnostics:** every structured log line (app launch, session start/restart, errors, timings) streams to a Supabase `device_logs` table (row-level security, anon key). The maintainer queries it over REST to diagnose without the owner describing anything. This has already been used to find two real bugs.

**Modularity claim:** swapping the speech engine = replacing one module. Swapping the LLM = one entry in a provider registry. Restyling = one design-token file. Decisions are recorded as ADRs in `docs/decisions/`.

---

## 6. Validation performed against reported bugs

Sources: the library's GitHub issues, its **Android source code**, whisper.cpp discussions, Android developer docs.

| Known problem | Our position |
|---|---|
| Beep on every start/stop (hardcoded in `SpeechRecognizer`) | Avoided — `continuous` + audio-persist set a custom audio source, which suppresses it |
| Continuous mode is *segmented*; finals must be concatenated by the app | Handled — we accumulate finals (documented contract) |
| "Stops after 5–8 s despite `continuous: true`" (issue #98, open) | Mitigated — reporter used **network** recognition; we force on-device + segmented session, plus auto-restart (the accepted fix) |
| "network error after N seconds" (issue #131, open) | Likely avoided — network-mode bug; we never use the network path |
| Silent death on incoming phone call, no error emitted (issue #135, open) | Mitigated — 30 s stall watchdog forces a restart |
| `ERROR_RECOGNIZER_BUSY` on rapid restart | Handled — restart debounce, longer delay after a `busy` error |
| On-device needs Android 13+ and a downloaded language pack | Fine on Pixel 9 Pro; Settings shows install status + one-tap download |
| Background/screen-off needs a foreground service | **Only partly addressed** — see §7 |

**Key finding from reading `ExpoSpeechService.kt` directly:** on Android 13+ with audio persistence, the library uses `EXTRA_SEGMENTED_SESSION` + `EXTRA_AUDIO_SOURCE`, and **any error tears down the session and emits `end`**. This confirms that restarting on `end` is the correct and sufficient recovery hook — the biggest open question in the design.

### Robustness added after review

1. **Never lose a meeting** — the meeting row is created *when recording starts*; the transcript is saved every 5 s and when the app is backgrounded. Previously the transcript was only written on Stop, meaning a crash 90 minutes into a 2-hour meeting would have lost everything. This was a serious self-inflicted bug found during architecture review.
2. **Crash recovery** — meetings left in `recording` state are recovered on next launch.
3. **Stall watchdog**, **restart debounce**, **real audio paths from the `audioend` event**, **keep-awake during recording**.

---

## 7. Known risks and open questions — please challenge these

1. **Screen-off / phone-in-pocket is NOT solved.** Android throttles backgrounded apps. The correct fix is a **foreground service** (e.g. notifee), deliberately deferred to keep this build small. Today, reliable operation likely requires the app foregrounded with the screen on (keep-awake is enabled). *This directly conflicts with the "wearable replacement, button in pocket" goal.* **Is deferring this right, or is it the whole product?**

2. **The accuracy vs speed contradiction.** The owner stated "accuracy over speed, time is not a constraint," then was (reasonably) furious at 2-hour processing. The real requirement is *accurate AND not absurdly slow*. Google's on-device engine is fast and good at Hinglish, but is **probably less accurate than Whisper-large** on hard audio. **Is trading peak accuracy for real-time the right call — or should the design be: live native transcript for immediacy + an optional overnight Whisper/cloud pass for archival accuracy?**

3. **Far-field accuracy is unproven.** Phone on a meeting table, 4–6 speakers, is a much harder problem than dictation. On-device models are typically tuned for close-mic dictation. The Hollyland lavaliers should help materially, but this is untested.

4. **Restart gaps.** Sessions restart on `end`; a word spoken exactly during a restart may be lost. Frequency and impact are unknown — measurable from the log stream.

5. **Library version skew.** `expo-speech-recognition` 56.0.1 targets Expo SDK 56; the project runs SDK 57. Dependency checks, bundling and prebuild all pass, but this is only truly proven by a device build.

6. **No speaker labels.** The engine does not diarise ("Speaker 1 / Speaker 2"), which was in the original product spec. Would need a separate approach.

7. **Vendor lock to Google's on-device engine.** If Google changes or removes it, the app degrades. Mitigation is the swap-seam, plus Vosk (offline, Hindi, 50 MB models) as an untested alternative.

8. **Battery/thermal over hours** with continuous recognition + screen-on is unmeasured.

---

## 8. What is built vs not built

**Built and locally verified (not yet device-tested):**
- Live transcription with auto-restart, crash-proof incremental saving, crash recovery
- Meetings list, meeting detail, delete, re-transcribe from saved audio
- Settings: language picker (hi-IN / en-IN / en-US), offline language pack download + status, on-device support check
- Diagnostics screen (on-device logs + share), remote log streaming, error boundary
- SQLite with versioned migrations; Electric Grape design system (light + dark)
- CI-less but disciplined: typecheck + JS bundle + `expo prebuild` verified before every build

**Not built yet:**
- **Summaries + to-dos** (Phase 3) — provider registry exists (Gemini default/free, plus OpenAI, Anthropic, Grok, DeepSeek with user-supplied keys), but no API calls, no To-Dos tab logic, no export/share of `.md`/`.txt`
- **Bluetooth button** (Phase 4) — interface defined, not implemented
- **Foreground service** for background/pocket recording
- Speaker diarisation; search; calendar integration

**Verification discipline used before each cloud build** (builds are a limited resource): TypeScript compile, JS bundle, `expo prebuild` + manifest inspection, dependency compatibility check. This has already caught a stale config entry that *would* have failed a build.

---

## 9. Specific questions for the reviewer

1. Is **Android on-device `SpeechRecognizer`** the right engine for hours-long, multi-speaker, Hindi/English meetings — or is it fundamentally a *dictation* engine being misapplied to *meeting* audio?
2. Is the **restart-on-`end` loop** a sound way to achieve continuous multi-hour recognition, or is it a fragile hack that will drop content? What do production apps actually do?
3. Should the **foreground service** be built now rather than deferred, given the pocket/wearable use case?
4. Is **"live native + optional accurate second pass"** better than picking one engine? If so, what should the second pass be — Whisper on a laptop, or a cheap cloud batch API?
5. Is **Vosk** (or another offline engine) a materially better fit for Indian languages than Google's on-device model?
6. Any strong reason to reconsider **cloud streaming ASR** (e.g. Sarvam AI for Indic, AssemblyAI, Deepgram) despite the cost and privacy trade-off? Roughly what would a few hours a week cost?
7. Is the **modularity/swap-seam design** genuinely useful here, or over-engineering for a single-user app?
8. What is missing from the **risk register** in §7?

---

## 10. Repository

Private: `github.com/divayhere/maina`. Key docs:
- `docs/decisions/0001-foundations.md` — locked product/platform decisions
- `docs/decisions/0002-audio-pipeline.md` — the Whisper audio pipeline (now superseded)
- `docs/decisions/0003-hours-long-pipeline.md` — segmented recording + resumable transcription (superseded by the native engine)
- `docs/decisions/0004-native-speech-architecture.md` — current architecture, validation, risk register
- `docs/CHANGELOG.md` — full version history
