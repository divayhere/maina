# Maina — Full Context & Handoff Pack

**For:** whoever picks up development next (Codex/other agent/human).
**State:** v0.8.1 source candidate is implemented on `codex/v0.8-observability`. It hardens v0.8 diagnostics delivery, measures real capture gaps, adds retry recovery and versions the native diagnostics database. See ADRs 0005–0006 and the changelog; the detailed v0.6 audit below remains historical evidence. Device endurance testing is still required before trusting a real meeting. No v0.8.x EAS build has been submitted.
**Date:** 18 Aug 2026

---

## 0. DO THIS FIRST — security

These credentials were pasted into a chat transcript and must be **rotated/revoked**:

1. **GitHub fine-grained PAT pasted in chat** — repo `divayhere/maina`, Contents R/W. Revoke at GitHub → Settings → Developer settings → Personal access tokens.
2. **Supabase Management token pasted in chat** — full account access. Revoke at supabase.com/dashboard/account/tokens.
3. **Expo tokens pasted in chat** — revoke all exposed tokens at expo.dev → account → Access tokens after this authorized build.
4. **Supabase RLS is currently unsafe.** The `device_logs` table has an `anon can read logs` SELECT policy. The anon key is embedded in the APK, so **anyone with the APK can read every log**. Fix: drop the SELECT policy, keep insert-only, and read logs via a service-role key from the maintainer side only.

v0.7 removes the embedded key and leaves remote logging disabled until RLS is repaired.

---

## 1. Product

A personal meeting recorder for **one user** (not a public product). Replaces Fireflies.ai + AI-wearable necklaces.

**Flow:** press a physical button → capture meeting (in-person, or beside a laptop on Meet/Teams) → transcript → AI summary + to-dos → searchable history, exportable as `.md`/`.txt`.

**Hard requirements:**

| # | Requirement | Status |
|---|---|---|
| 1 | Zero/near-zero recurring cost (per-meeting LLM pennies OK; per-minute ASR not) | Met by on-device ASR |
| 2 | Accurate transcription; speed matters too (see §7 note) | Unproven |
| 3 | Hours-long continuous recording, seamless, recording = source of truth | **NOT met** |
| 4 | Hindi, English, mixed Hinglish — top priority | Unproven |
| 5 | Physical Bluetooth button, hands-free (non-negotiable) | **Not built** |
| 6 | Private — audio should not go to third-party servers | **Currently fails open** |
| 7 | Modular — swap AI models/providers without breaking things | Partially |
| 8 | Self-diagnosing — owner never has to describe a bug | Partially |
| 9 | Simple Apple-like UI, some personality ("Electric Grape" palette) | Done |
| 10 | No Apple Developer account | Met (Android) |

**Owner does not code.** Deliverable is an APK he sideloads. Keep explanations plain.

**Owner's workflow preference:** when he reports a problem — pull the logs and diagnose yourself, research, then **report in plain language and WAIT for permission before building**. EAS build credits are limited; never build unless he explicitly says "build".

---

## 2. Platform & hardware decisions (locked, with rationale)

- **Android only, Pixel 9 Pro.** iOS rejected: background mic blocked for normal apps, BLE HID button restricted, and free sideloading expires every 7 days. (Audit note: iOS *can* continue a recording started in the foreground via the audio background mode — the reasoning was partly wrong, but the conclusion stands.)
- **Native app, not a PWA/Lovable.** Web can't do background audio, BLE HID, or on-device ASR.
- **Mic:** Hollyland Lark M2 (2 TX + USB-C mobile RX, ~₹10k) — purchased and first tested in v0.8.1. Android exposed it as `USB-Audio - Wireless microphone`, but v0.8.1 only inventories available inputs and cannot prove which device the recognizer actually routed. USB-C keeps Bluetooth free for the button.
- **Button:** must connect **directly to the phone** — BLE HID shutter clicker, or Flic 2 (has an Android SDK). Aqara/Tapo rejected: they need a hub + cloud, useless in a client's meeting room. *Not yet purchased.*

---

## 3. What was tried and why it changed

### Attempt 1 — Whisper on-device (`whisper.rn`). FAILED, removed.

Measured on the Pixel 9 Pro (`large-v3-turbo`, q5_0, 6 threads):

| Audio | Time | Output |
|---|---|---|
| 15 s Hindi (close mic) | 90 s | 160 chars (usable) |
| 30 s | 190 s | 13 chars |
| 30 s | 132 s | 41 chars |
| 30 s | **29 min** | 10 chars |
| 30 s | **65 min** | 10 chars |

Causes: **q5_0 is 3–5.5× slower than q4_0** (implementation error); whisper.cpp on Android is **CPU-only** (no NPU); **thermal throttling**; and Whisper **decoder retry loops** on quiet audio (huge time, ~10 chars out — test audio was too quiet).

Conclusion: Whisper-large on a phone CPU cannot be real-time. Removed entirely along with 4 native deps (`whisper.rn`, `@fugood/react-native-audio-pcm-stream`, `buffer`, `expo-audio`).

### Attempt 2 — Android `SpeechRecognizer` (current)

Via `expo-speech-recognition@56.0.1`, targeting Google's on-device service. Live partial results, free, offline. Config: `continuous`, `requiresOnDeviceRecognition`, `interimResults`, `addsPunctuation`, `recordingOptions.persist`, `EXTRA_ENABLE_LANGUAGE_SWITCH: 'balanced'`.

Verified from library source (`ExpoSpeechService.kt`): on Android 13+ with persist, it uses `EXTRA_SEGMENTED_SESSION` + `EXTRA_AUDIO_SOURCE`, and **any error tears down the session and emits `end`** — so restart-on-`end` is the correct recovery hook. This also suppresses the notorious start/stop beep.

---

## 4. Current code map

```
src/
  app/
    _layout.tsx            root: db init, crash recovery, watchdog, error boundary
    (tabs)/index.tsx       Meetings list + record button
    (tabs)/todos.tsx       STUB
    (tabs)/settings.tsx    automatic bilingual readiness, provider status, system-status link
    record.tsx             live transcription screen (restart loop, persistence)
    meeting/[id].tsx       transcript, re-transcribe from saved audio, delete
    diagnostics.tsx        durable outbox/upload/model/input status
  core/
    transcription/nativeSpeech.ts   ← engine wrapper (intended swap-seam)
    summarization/providers.ts      ← Gemini/OpenAI/Anthropic/Grok/DeepSeek registry (unused yet)
    summarization/types.ts          ← Summarizer interface (unimplemented)
  data/
    db.ts                  SQLite + migration runner (v1..v3)
    meetings.ts            repo + recoverInterruptedMeetings()
    settings.ts            k/v (speech language)
  design/                  tokens.ts (Electric Grape), components.tsx, theme.ts, ErrorBoundary.tsx
  hardware/
    recording/paths.ts     recording dir + segment naming
    trigger/types.ts       TriggerSource interface — NOT IMPLEMENTED
    mic/types.ts           MicSource interface — NOT IMPLEMENTED
  services/
    logger.ts              structured ring-buffer logger
    watchdog.ts            global JS error capture + persisted log
    remoteLog.ts           Supabase log streaming
    remoteConfig.ts        Supabase URL + anon key (HARDCODED)
    config.ts              feature flags
docs/
  decisions/0001..0004     ADRs (0002/0003 superseded by 0004)
  CHANGELOG.md, REVIEW.md, HANDOFF.md
```

**Stack:** Expo SDK 57, RN 0.86, React 19, TypeScript, expo-router, expo-sqlite, Zustand, EAS cloud builds → APK.

**Infra:** private repo `github.com/divayhere/maina`; Expo project `divayheres-team/maina` (EAS `preview` profile builds an internal-distribution APK); Supabase project `voqanxnevtugrfcyvuuf` with `device_logs`.

---

## 5. AUDIT FINDINGS — all confirmed against source. This is the work list.

An independent audit reviewed v0.6.0. **Every critical finding was verified as correct**, including ones that contradict earlier claims in `docs/REVIEW.md` and ADR 0004. Those documents are now partly wrong; this section supersedes them.

### C1 — "Never lose a meeting" is FALSE (critical)
The library records to a **temp raw PCM file** and only writes the WAV **on `stop()`**, via `pcmFile.readBytes()` — loading the **entire file into memory**.
`node_modules/expo-speech-recognition/android/.../ExpoAudioRecorder.kt` (~L108 readBytes, ~L164 finalize on stop).
- 1 h ≈ 115 MB, 2 h ≈ 230 MB → realistic **OOM crash** on long meetings.
- If the process dies first, you get an **orphan temp PCM**, not a usable recording.
→ Recording is NOT crash-safe. This is the single biggest gap.

### C2 — Stop can lose or duplicate the final sentence
`record.tsx` calls `stopSession()` then waits an arbitrary **700 ms**. The native side waits asynchronously for a later result/error callback. Upstream issue #158 documents losing the open final segment when stopping right after speech.
→ Needs an **event-driven stop state machine**: request stop → await final (or timeout) → use last partial only if no final arrived → await `audioend` → verify file exists + valid header/size → commit transaction → navigate.

### C3 — "Transcript saved every 5 seconds" is FALSE
`SAVE_EVERY_MS` is only a **throttle**; there is no periodic timer. `persist()` runs on a **final result** and on **backgrounding** only; the 1 s watchdog does **not** persist.
→ A crash loses everything since the last final result, including the live partial. My earlier claim ("loses at most 5 s") was **wrong**.

### C4 — Privacy fails open
If `supportsOnDevice()` returns false, the app **silently** starts the default recognizer, which may stream audio to Google's servers. Same in the saved-audio re-transcribe path (`nativeSpeech.ts`).
→ Must **fail closed**: block recording and tell the user to download the offline model. Network ASR only via explicit per-meeting opt-in.

### C5 — There is no foreground service
Declaring `FOREGROUND_SERVICE_*` permissions does not create a service. The library's `ExpoSpeechService` is a plain Kotlin class, **not** an Android `Service`.
→ Screen-off, pocket, and the physical button are all unsolved. Android 14+ also **blocks starting a mic foreground service from the background**, so the realistic design is:
user opens Maina → taps "Arm" → foreground service starts while visible → Flic stays connected via that service → button toggles recording inside the running service → re-arm after force-stop/reboot.
A fully dead app waking from a generic shutter button and starting the mic is **not** something Android guarantees.

### C6 — Overconfident engine claims (fix the comments/docs)
- "NPU-backed" is **unprovable** — Android doesn't expose which processor runs it. Remove the claim.
- With `requiresOnDeviceRecognition: true` the library calls `createOnDeviceSpeechRecognizer()` and the supplied `com.google.android.as` package is **not** explicitly selected in that branch.
- `EXTRA_ENABLE_LANGUAGE_SWITCH` is **best-effort**, may be ignored, and needs both language models installed.
- v0.8 logs the actual Android switch result/code and constrains candidates to `en-IN` + `hi-IN`; device evidence is still required to demonstrate reliable Hinglish switching.
- Android docs state `SpeechRecognizer` is **not intended for continuous recognition**.

### C7 — The swap-seam is not real
`record.tsx` and `meeting/[id].tsx` both import `useSpeechRecognitionEvent` **directly from the vendor library**, so swapping engines touches UI lifecycle, not just `nativeSpeech.ts`.
→ Define a real interface: `start()/requestStop()/abort()`, partial+final events, language events, health/status events, explicit session id, completion as a promise/state transition, and capability flags (offline, file transcription, timestamps, diarization).

### C8 — Diagnostics incomplete and risky
- **No Sentry** — native crashes and ANRs are never captured.
- `remoteLog.ts` never checks `response.ok`, so 401/403/500 are treated as success.
- The queue is **in-memory only** → logs vanish in the crash you most want to debug.
- **Anon SELECT policy** on `device_logs` = anyone with the APK can read all logs (see §0).
- Remote logging is permanently on with a hardcoded endpoint.
→ Split: **Sentry** for native/JS crashes + ANRs; **Supabase insert-only** for scrubbed telemetry; **local durable rotating log** for sharing. **Never** send transcripts, audio, keys, contact names, or meeting titles to diagnostics.

### C9 — Data risks
- The **v3 migration runs two `ALTER TABLE`s without a transaction** → interruption leaves a half-migrated schema. Wrap each migration in a transaction.
- **Android Auto Backup is not excluded** → transcripts/DB may sync to the user's Google Drive. Add backup exclusion rules.
- Future API keys must use **Android Keystore** (`expo-secure-store`), never SQLite.
- Original requirement was **delete audio after transcription**; current build keeps it indefinitely. Needs a **retention policy** (owner later chose "keep as safety net" — make it configurable with a default).
- `package.json`, `app.json`, Android `versionCode`, changelog and schema version have **no single source of truth**.

---

## 6. Target architecture (agreed)

```
Flic button / notification / UI
        ↓
Native Android FOREGROUND SERVICE  ← owns the session
        ↓
Single native AudioRecord owner (not a React component)
        ├─→ crash-safe 30–60 s WAV segments, finalized incrementally
        │        └─→ segment manifest + SQLite (seq numbers + timestamps)
        └─→ live ASR adapter (Android SpeechRecognizer) → timestamped live transcript
                 ↓
        Optional accurate second pass (on selected meetings)
                 ├─ local Whisper large-v3 on a laptop
                 └─ opt-in cloud (Sarvam) when diarization / best Indic needed
                 ↓
        Transcript repository → summary / translation / to-dos / export
```

**Principles:**
- **One native microphone owner.** React components must never own recording.
- **Live transcription is a convenience layer, not the source of truth.** The audio segments are.
- Segments carry **sequence numbers + timestamps** so transcripts can be merged, retried, deduplicated, and gaps measured across recognizer restarts.
- Finalize every segment incrementally; a damaged final segment should be repairable from byte length.
- Preserve the original **Hindi/Hinglish** transcript; English translation is a **derived view**; summaries default to English.
- The Hollyland Lark M2 **mobile** receiver officially exposes mono only, so its two transmitters cannot be treated as separate diarization channels on the phone. Speaker attribution must remain a separate ASR/diarization problem.

**Next-build microphone requirement (no UX change):** while recognition is active, query Android's active recording configurations and log the actual routed `AudioDeviceInfo`, source, client/actual formats, channel count and enabled capture effects. Register the recording callback so USB attach/detach or route changes are timestamped. If the Hollyland is visible but the active route is the built-in microphone, raise a remote diagnostic warning. Do not claim that Maina can force the route: `SpeechRecognizer` owns its internal `AudioRecord`, whereas `setPreferredDevice()` only applies to an `AudioRecord` owned by the app.

⚠️ **Scope warning:** this requires real **native Kotlin** work (a foreground service + recorder, exposed via an Expo config plugin / native module). That is a meaningful step up from the current managed-workflow JS app. Plan for it explicitly.

---

## 7. Execution order (agreed)

1. **Security cleanup** — rotate the tokens in §0, fix the Supabase RLS to insert-only.
2. **Design doc** for the native recorder + foreground service (before coding).
3. **Golden corpus** — a fixed 30–45 min test set: English, Hindi, Hinglish, far-field, multi-speaker, silence, laptop playback. *Nothing can be evaluated without this.*
4. **Benchmark** against that corpus: Android `SpeechRecognizer` (on-device), ML Kit Basic, AI4Bharat IndicConformer via `sherpa-onnx`. Measure WER + latency + battery.
5. **Implement** the crash-safe native recorder + the stop state machine (C1, C2, C3).
6. **Soak test** — 3 hours, screen off, with interruptions: phone call, USB disconnect, button presses, airplane mode; record thermal + battery.
7. **Flic integration.**
8. **Only then** summaries, to-dos, translation, diarization, export.

**Freeze** all summary/to-do/UI feature work until steps 1–6 are done.

---

## 8. Engine options — evidence gathered (verify independently)

| Option | Notes |
|---|---|
| **Android SpeechRecognizer (on-device)** | Current. Free, live, offline, good Hinglish reputation. But it's a *dictation* API; Android docs say it's not intended for continuous use. |
| **ML Kit GenAI Speech Recognition** | Worth benchmarking, not switching blindly. Basic mode streams + supports `hi-IN`; better Advanced mode reported **Pixel 10 only**; API is **alpha**, no compatibility SLA. |
| **AI4Bharat IndicConformer + sherpa-onnx** | Strongest open-source Indic candidate; real-time, deployable on Android, offline. Unproven for far-field Hinglish. Treat third-party model conversions as **supply-chain risk** — pin commits, keep checksums, prefer converting official weights yourself. |
| **Vosk** | Reported ~21–25% WER Hindi, ~49% Indian English on its listed sets; no compelling Hinglish evidence. **Not recommended.** |
| **Whisper large-v3 on a laptop** | Best accuracy path for archival re-processing. Off-device, so no phone thermal/battery cost. |
| **Sarvam (cloud, Indic)** | Code-mixed speech, 23 languages, diarization, auto language detection. ~₹30/hr (₹45 with diarization) → **₹260–975/month at 2–5 h/week**. ⚠️ This **conflicts with hard requirement #1 (no recurring cost)** and #6 (privacy) — must be an explicit opt-in decision by the owner, not a default. |

---

## 9. Open questions for the owner

1. **Requirement #1 vs. accuracy:** is a cloud Indic ASR (~₹300–1000/month) acceptable for *important* meetings only, as an explicit per-meeting toggle? This directly contradicts "no recurring cost" as stated.
2. **Audio retention:** original spec said delete audio after transcription; current behaviour keeps it. What's the default retention (e.g. delete after 7 days / after summary / keep until manual)?
3. **Scope:** is he happy for the project to take on **native Kotlin** development (needed for the foreground service)? It increases complexity and build risk.
4. **Diarization** ("Speaker 1/2") was in the original spec but no on-device engine provides it. Drop, or accept cloud for meetings where it matters?

---

## 10. Verification discipline (keep this)

EAS build credits are **limited**. Before any build, always run:

```bash
npx tsc --noEmit                                   # types
npx expo export --platform android --output-dir /tmp/x   # JS bundle (check REAL exit code)
npx expo prebuild --platform android --no-install --clean # native config + manifest; then rm -rf android
npx expo install --check                           # dependency compatibility
```

This has already caught a stale `expo-audio` plugin entry that would have failed a build. Note: `expo export` piped to `tail` masks its exit code — capture `$?` directly.

**Remote log query** (maintainer side; use a service-role key once RLS is fixed):
```bash
curl -s "$SUPABASE_URL/rest/v1/device_logs?select=ts,level,scope,message,context&order=created_at.desc&limit=50" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

---

## 11. Bottom line

v0.6.0 is a **promising foreground dictation prototype**, not a reliable meeting recorder. Tag it as an experimental baseline. The gap between it and the product is **C1–C5**: crash-safe native recording, a correct stop sequence, real persistence, fail-closed privacy, and a genuine foreground service. Everything else — summaries, to-dos, export, UI — should wait.
