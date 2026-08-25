# Maina local-first meeting engine research

Date: 26 August 2026  
Scope: Android capture, on-device English/Hindi/Hinglish transcription, durable post-processing, storage, device tiers, and the hand-off to cloud notes/MKC.  
Method: current-code audit, Pixel 9 Pro evidence review, supplied-audio benchmarks, and primary-source review. No APK was built or installed during this research pass.

## Executive decision

Maina is on the right architectural trajectory. It does **not** need a rewrite and it should not become a chain of Whisper + Zipformer + Parakeet + Qwen. The correct product split remains:

1. native Android foreground capture writes durable local audio;
2. a model-neutral post-capture queue transcribes locally;
3. Qwen3-ASR 0.6B INT8 is the primary high-tier English/Hindi/Hinglish recognizer;
4. transcript text is permanent; completed audio is disposable recovery material;
5. cloud LLMs generate notes, decisions, open questions, and to-dos;
6. MKC receives only finalized canonical content and later corrections through its existing lineage contract.

The current implementation is stronger at recording than at finishing the post-recording pipeline. A real 8m54s Pixel run captured one continuous WAV with zero reported route restarts and zero reported capture gap, then Qwen completed 40 of 41 windows. One dense window repeatedly hit the 128-token output limit. That single failure correctly blocked notes and MKC, but retry unnecessarily recomputed all windows after the native result was acknowledged.

**Recommendation:** keep the capture engine, Qwen, native outbox, cloud packet path, MKC contract, and retention policy. Finish six bounded reliability gaps before calling the Android app complete.

## What is already right

| Area | Assessment | Evidence |
| --- | --- | --- |
| Background recording | Keep | Native `AudioRecord` capture runs in a microphone foreground service and survives screen-off use. This matches Android's supported pattern. |
| Capture-first architecture | Keep | Audio is durable before ASR. A recognizer crash cannot erase the meeting. |
| Mic-route handling | Keep, then extend tests | Android routing callbacks and capture restarts are present. Prior route-switch tests stayed within the user's acceptable 2–3 second practical boundary. |
| ASR process isolation | Keep | Qwen runs in a private `:asr` media-processing service, protecting the UI process from its roughly 2.65 GB observed working set. |
| Bounded inference | Keep | Qwen uses upstream-like `512/128`, two CPU threads, one job at a time, and releases the recognizer. This avoids the earlier pathological large KV-cache configuration. |
| Durable native outbox | Keep | Window outcomes and transcript blocks are written in a separate WAL SQLite outbox while ASR runs. |
| Partial-content safety | Keep | Notes and MKC sync are blocked when transcript coverage is incomplete. This is the correct truth boundary. |
| Audio retention policy | Keep intent | Complete audio is planned for immediate deletion; incomplete audio is limited by seven days or 1 GB; active readers are excluded. |
| Cloud division of labour | Keep | Local ASR handles private/cheap transcription; cloud LLM handles higher-intelligence notes; MKC owns semantic enrichment. |

## Direct benchmark on Divay's supplied recordings

These measurements use the same sherpa-onnx 1.13.6 runtime family and the exact Qwen3-ASR 0.6B INT8 model pack copied from the Pixel. They are Mac CPU comparisons, not claimed Android speed figures. No gold transcript was provided, so quality is a qualitative side-by-side audit rather than a fabricated WER score.

### First 90 seconds

| Engine/configuration | Hindi elapsed / RTF | Indian-English elapsed / RTF | Practical quality |
| --- | ---: | ---: | --- |
| Qwen, 15s windows, 2s overlap, 128 tokens | 49.5s / 0.48 | 35.7s / 0.35 | Best Hindi and strong English, but 4/7 dense Hindi windows touched the token ceiling. |
| Whisper-small INT8, forced language | 35.4s / 0.35 | 21.9s / 0.22 | Strong English; Hindi output was badly corrupted and one window was empty. Reject as general Hindi fallback. |
| Omnilingual CTC 300M INT8 | 27.3s / 0.27 | 27.7s / 0.27 | Faster, but materially weaker; Hindi switched into Urdu script and one window was empty. Reject as primary. |
| Qwen, one midpoint retry level | 64.6s / 0.72 | 18.5s / 0.21 | Reproduced Maina's real failure: one Hindi child still hit the limit. |
| Qwen, bounded two-level low-energy recovery | 50.8s / 0.56 | 15.5s / 0.17 | All tested Hindi and English leaves resolved without increasing token/KV limits. Best recovery design tested. |

Important interpretation:

- Qwen remains the winner for Maina's real language mix.
- Whisper-small is a credible **English-only** secondary option, not a safe automatic Hinglish/Hindi fallback in the tested sherpa export.
- Omnilingual is not accurate enough to replace Qwen merely because it is smaller/faster.
- Fixed 8-second chunks reduced truncation but lost context and caused language/script instability. Global tiny chunks are not the answer.
- Low-energy splitting is useful, but it must be combined with bounded recursive recovery; a single low-energy 8-second target still produced one dense Hindi truncation.
- A multi-model cascade on every meeting would multiply RAM, storage, battery, model-download, and failure surfaces without demonstrated value.

The Pixel's real 8m54s run took roughly 4m25s for 41 Qwen windows, about 0.50 real-time factor. A one-hour dense meeting should therefore currently be expected to take tens of minutes on this Pixel, not 3–5 minutes. The architecture is offline and economical, but the product must not promise cloud-speed completion on CPU-only Android.

## Confirmed gaps and exact fixes

### P0.1 — Replace one-level blind retry with bounded recursive recovery

**Problem:** `MainaPostProcessingSupport.splitForRetry()` splits once around the arithmetic midpoint. Dense Hindi can still cap a child; one failed child keeps the entire meeting partial.

**Build:**

- retain 15-second/2-second-overlap base windows for context;
- when Qwen returns blank speech or token-cap evidence, find a low-energy boundary near the midpoint;
- discard the suspicious parent's text and decode the two sample-exact children;
- recurse at most two levels, with a minimum child duration around 3–4 seconds;
- preserve original absolute sample/time ranges and record every attempt in evidence;
- if the final leaf still fails, mark only that interval incomplete.

**Why this is conservative:** Qwen's official splitter searches for low-energy boundaries and guarantees sample-exact coverage with no gaps or overlaps. sherpa-onnx itself recommends shorter audio when generation is truncated. The supplied-Hindi benchmark cleared all leaves with this bounded policy.

**Qualification:** deterministic unit tests for sample coverage, no duplicate child ranges, maximum depth, and stable ordering; supplied Hindi/English fixtures; a fresh 30–60 minute Pixel run; forced synthetic token-cap test.

### P0.2 — Preserve a compact retry manifest after Expo import

**Problem:** native resume already skips completed windows while its outbox row exists. However, `acknowledge()` deletes `runs`, `blocks`, and `window_results` after Expo imports either a complete **or partial** result. A later retry has no completed-window map and starts at window zero.

**Build:**

- complete runs: acknowledge and delete native evidence as today;
- partial runs: retain a compact manifest containing run ID, audio fingerprint, window plan version, completed keys, failed keys, and block checksums;
- Expo may import visible transcript blocks, but retry must reuse the same manifest and decode failed keys only;
- invalidate the manifest only when audio fingerprint, model-pack version, or window-plan version changes;
- delete the manifest after complete import or audio expiry.

**Qualification:** kill process at every window boundary; import partial; retry; assert only failed keys decode; repeat retry idempotently; corrupt one manifest field and prove safe full re-plan rather than silent reuse.

### P0.3 — Make background continuation truthful and durable

**Problem:** Maina has a good `mediaProcessing` foreground service, six-hour wake-lock bound, `onTimeout()`, and a WorkManager recovery worker. But the worker currently only posts “open Maina to continue”; it does not continue ASR. Android 15+ also limits `mediaProcessing` foreground services to six aggregate background hours per 24 hours.

**Build:**

- keep the direct media-processing foreground service for immediate user-started post-processing;
- persist a resumable checkpoint at every window (already largely present);
- use one unique WorkManager reconciliation job per meeting for deferred/reboot recovery;
- when platform rules permit, continue bounded work; otherwise post an accurate resume action without marking progress as active;
- record Android stop reason, thermal state, battery constraint, and next eligible action;
- never start a second ASR job while recording or another ASR job is active;
- test the Android media-processing timeout using the official `device_config` override.

**Qualification:** app process kill, ASR process kill, device reboot, forced media-processing timeout, low battery, thermal throttle, and a new recording preempting ASR. Every test must resume from the last completed window or show a truthful deferred state.

### P0.4 — Build a real model-pack lifecycle and device tiers

**Problem:** the current Pixel pack is manually installed outside the APK. Readiness checks expected file sizes but not cryptographic hashes. Clearing app data or installing on a second phone can leave Maina unable to transcribe. Qwen's observed working set also cannot be promised on low-RAM phones.

**Build:**

- signed/versioned manifest with source URL, file sizes, SHA-256 values, engine/runtime compatibility, required free space, and minimum tier;
- download to `.part`, support HTTP range resume, verify every hash, then atomic rename;
- retain last-known-good pack until the new pack loads in a smoke decode;
- preflight `StorageManager.getAllocatableBytes()` and device memory;
- select a documented tier from `ActivityManager.MemoryInfo.totalMem`, `lowMemory`, and a one-time model smoke benchmark;
- high tier: Qwen 0.6B INT8;
- lower tiers: explicitly degraded smaller model chosen only after the same Hindi/English benchmark. Do not silently run Qwen until the OS kills it.

**Truthful boundary:** current evidence qualifies Qwen on the Pixel 9 Pro, not on every low-end Android phone. Whisper tiny/base are proven Android-sized options, but their Hindi/Hinglish quality must be measured before selection.

### P0.5 — Fix timestamp and active-progress truth

**Problem:** a fresh partial meeting displayed transcript rows at `5:30 am`, the IST rendering of Unix epoch zero. Native blocks use `meetingStartedAt + windowOffset`; a zero start therefore leaks into user-visible times. During active native ASR, blocks are not imported until terminal state, while the meeting screen can say no blocks exist.

**Build:**

- persist meeting start in native capture metadata, not only the service's volatile field;
- on post-processing launch, validate `meetingStartedAt > 0`; reconstruct from durable capture metadata or meeting DB, never default silently to zero;
- show transcript blocks as elapsed offsets (`00:00`, `00:13`) by default; wall-clock time belongs in meeting metadata;
- active ASR UI reads persisted `completedWindows / windowCount` and says “Transcribing locally”; do not imply terminal absence;
- use determinate progress only when total windows is known; otherwise show indeterminate state.

**Qualification:** start from UI, clicker/lock screen, process restart, and recovered recording; assert no epoch timestamps and monotonic offsets.

### P0.6 — Prove retention deletion through the native-file boundary

**Problem:** retention policy logic is correct, but audio lives under native app-private/external app storage and deletion is attempted through Expo FileSystem. This must be proven on device; a silent caught deletion error can leave WAV directories while clearing the DB pointer.

**Build:**

- add a native inspect/delete bridge for capture directories;
- delete completed audio only after the transcript transaction is durable and, when enabled, canonical MKC enqueue has frozen its text payload;
- incomplete audio remains bounded by seven days **or** 1 GB, whichever is hit first; active capture/ASR is never deleted;
- confirm deletion before clearing `audioUri`; if deletion fails, retain the pointer and retry;
- preflight free space before recording and reserve enough for the configured chunk size;
- expose aggregate storage, not raw file-management complexity.

**Qualification:** complete, partial, interrupted, active-reader, deletion-failure, 1 GB rollover, seven-day expiry, and app restart tests; compare filesystem bytes before/after.

## P1 after the six finishers

These are useful, but they should not delay the reliable local-first release:

1. **Selective speech enhancement experiment.** Do not enable Android NS/AGC globally. AOSP explicitly warns against default noise suppression for `VOICE_RECOGNITION`. A/B test sherpa GTCRN/DPDFNet only on low-SNR failed leaves; accept it only if Hindi/English word recovery improves without hallucination.
2. **Speaker diarization and “You” identification.** sherpa-onnx exposes diarization and speaker embeddings on Android-capable runtimes, but this adds models, RAM, time, and a separate error metric. It labels who spoke; it cannot reconstruct words physically lost when people overlap on one mono microphone. Add only after transcript completeness is stable.
3. **English-only fallback.** Whisper-small was strong on the supplied English clip. It can be trialled only for leaves confidently detected as English after Qwen failure, not for Hindi/mixed speech and not in the primary path.
4. **Adaptive hotwords.** Qwen supports hotwords; meeting/company names may improve. Keep the list short because hotwords consume prompt context and can bias output.
5. **Lower-device qualification matrix.** Test at least 4 GB, 6 GB, and 8 GB+ arm64 phones with the same fixtures, thermal run, and process-kill suite before advertising broad compatibility.

## What not to build

- Do not replace Qwen with Whisper-turbo/large on Android. Upstream Whisper Android guidance recommends tiny or base; large models have multi-gigabyte memory footprints.
- Do not run Whisper + Zipformer + Parakeet + Qwen sequentially. sherpa-onnx is a runtime supporting many engines, not evidence that all should run on every recording.
- Do not make ASR real-time a P0. Maina is a meeting-memory product, not a dictation app. A waveform/level heartbeat is enough during capture.
- Do not apply aggressive gain, AGC, or denoise universally. It cannot recover speech the microphone never captured and can damage far-field speech.
- Do not promise 100% verbatim accuracy or full recovery of simultaneous speakers from one mono microphone. Preserve audio until coverage succeeds, surface uncertainty, and let the cloud LLM structure—not invent—the transcript.
- Do not change MKC's immutable source/frozen-payload contract for these fixes.
- Do not put the local model into the APK; use a verified post-install pack.

## Target end-to-end state machine

```text
IDLE/ARMED
  -> RECORDING (microphone FGS, durable PCM/WAV chunks)
  -> FINALIZING (WAV header + capture manifest committed)
  -> ASR_QUEUED
  -> ASR_RUNNING (window checkpoint after every leaf)
       -> ASR_DEFERRED (OS/quota/thermal/new recording; resumable)
       -> TRANSCRIPT_PARTIAL (only unresolved ranges retained)
       -> TRANSCRIPT_COMPLETE
  -> AUDIO_DELETE_PENDING
  -> NOTES_QUEUED / NOTES_READY (cloud LLM; retriable)
  -> MKC_QUEUED / SYNCED (frozen canonical payload)
```

Rules:

- recording always has priority over ASR;
- only one local ASR model instance runs;
- every long step is idempotent and checkpointed;
- transcript completeness is based on interval coverage, not merely non-empty text;
- cloud failure never affects local transcript durability;
- audio deletion never affects transcript, notes, or MKC content;
- UI state is derived from persisted stages, not timers or optimistic copy.

## Readiness score

| Capability | Current confidence | After six P0 fixes |
| --- | ---: | ---: |
| Pixel continuous capture | 88% | 95%+ after longer soak/kill tests |
| Mic-route continuity within practical 2–3s | 82% | 92% after a route matrix |
| Pixel English ASR completion | 85% | 95% target |
| Pixel Hindi/Hinglish ASR completion | 68% | 90–95% target with recursive recovery |
| Retry without wasted recomputation | 35% | 95% target |
| Fresh-install model readiness | 30% | 95% target |
| Lower-end Android readiness | 25% | Unknown until tier-device qualification |
| Notes/MKC after a complete transcript | 88% | 95% with one fresh end-to-end run |
| Overall “use through the week” confidence | 72% | Approximately 90% after P0 qualification |

These are engineering confidence estimates, not statistical accuracy guarantees. “100% bug-free” or “100% transcript accuracy” is not a credible promise for mobile ASR.

## Finish-only build order

1. recursive low-energy Qwen recovery;
2. partial-run retry manifest;
3. timestamp/progress truth fixes;
4. native retention deletion and free-space preflight;
5. model-pack installer plus Pixel/high-tier gate;
6. timeout/reboot/deferred-work qualification;
7. one 2–3 hour Pixel soak with screen off, one route-switch run, one process-kill run;
8. one complete transcript -> cloud notes -> MKC production sync run;
9. checkpoint and install the final candidate APK.

This is a bounded completion project, not another product redesign.

