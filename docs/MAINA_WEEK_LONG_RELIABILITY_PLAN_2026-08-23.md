# Maina week-long reliability plan

Date: 23 August 2026  
Target: Pixel 9 Pro personal beta  
Decision status: researched implementation plan; no code or APK change in this report

## Executive verdict

Maina's recording foundation is now materially stronger than its post-recording pipeline. The 47-minute device run captured essentially the full session and stopped correctly through the clicker. The week-test blocker is not microphone capture. It is the orchestration after capture: pathological Qwen decode latency, non-resumable partial ASR work, incomplete audio excluded from the 1 GB limit, progress that is not always tied to persisted work, and summary/cloud reconciliation that still depends too heavily on the foreground JavaScript runtime.

The most appropriate next build keeps the existing model and MKC contract. It changes the pipeline around them.

Plan confidence: **93%** that the design is the correct next architecture. This is not a promise that a multi-hour recording is proven until a device soak passes.

## The two resource problems are different

1. **Audio storage:** 1 GB is a disk-retention budget. Maina records 16 kHz, mono, 16-bit PCM, which is 32,000 bytes/second or about 115 MB/hour. A 1 GB budget therefore holds roughly 8.7 hours of raw audio (about 9.3 hours if the setting means 1 GiB).
2. **ASR working memory:** the observed roughly 2.65 GB PSS while Qwen was running is model/native working memory. Deleting old WAV files will reclaim disk, not this RAM. RAM must be controlled through bounded Qwen generation, process lifecycle, one-job concurrency, thermal policy, and recognizer release.

## Proven platform choices

- Keep recording in the existing microphone foreground service. Android explicitly supports the `microphone` foreground-service type for continuing voice recording in the background. Do not move capture into WorkManager.
- Use unique WorkManager work for durable orchestration and retries. Android recommends WorkManager for persistent work that survives app exit/reboot, supports constraints, unique jobs, chains, and exponential backoff. [Android task scheduling](https://developer.android.com/develop/background-work/background-tasks/persistent), [unique work](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work), [retry/backoff](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work)
- Keep native ASR in a `mediaProcessing` foreground service while decoding. Android limits that service type to six aggregate background hours per 24 hours on Android 15+, so Maina must checkpoint and stop cleanly on timeout instead of treating the service as endless. [Android foreground-service timeout](https://developer.android.com/develop/background-work/services/fgs/timeout)
- Run ASR in a private `:asr` process once its active-state handshake is made outbox-based. Android officially supports per-service private processes. This prevents a 2–3 GB recognizer working set or a native failure from freezing the UI/recording process and guarantees memory release when the ASR process exits. [Android service process](https://developer.android.com/guide/topics/manifest/service-element)
- Use Expo SDK 57 BackgroundTask only as a deferred JavaScript safety net for import, summary, cleanup and cloud sync. It uses WorkManager, has a 15-minute minimum on Android and is not exact-time execution. [Expo SDK 57 BackgroundTask](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/)

## P0 pipeline to build

### 1. One explicit durable state machine

Use independent persisted stages rather than one overloaded meeting status:

`recording -> audio_finalized -> asr_queued -> asr_running -> transcript_durable -> summary_queued -> summary_ready/failed -> mkc_queued -> mkc_synced/failed`

Each stage owns `state`, `attempt`, `updated_at`, `last_error`, and a measurable cursor. Failure in summary, cloud, or diagnostics must never roll back transcript or audio-capture state.

### 2. Resumable ASR at window level

- Give every planned window a deterministic identity: meeting, chunk index, window index, start/end.
- Persist the block and the completed cursor immediately after every successful decode.
- `begin()` must resume an existing running/deferred run; it must not create a new run or delete prior blocks.
- On restart, begin at the first unfinished window.
- Import running progress into the Maina DB for UI display; import transcript blocks as final only when coverage is complete.
- One active ASR job globally. The just-stopped meeting goes first; after it completes, drain older unfinished meetings oldest-first.
- A new recording preempts ASR at the next window boundary. Capture always has priority.

### 3. Bring Qwen back to upstream bounds

Maina currently uses `max_total_len=1536` and `max_new_tokens=512` for a 15-second window. sherpa-onnx's Java defaults and official C++ Qwen3 example use `512` and `128` respectively. Both Maina values are therefore three-to-four times the upstream bounded configuration, which fits the observed large KV-cache working set and long pathological generation tail. [Java default](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/java-api/src/main/java/com/k2fsa/sherpa/onnx/OfflineQwen3AsrModelConfig.java), [official C++ example](https://github.com/k2-fsa/sherpa-onnx/blob/master/cxx-api-examples/qwen3-asr-cxx-api.cc)

Next configuration:

- 15-second normal window, 2-second overlap
- `max_total_len=512`
- `max_new_tokens=128`
- deterministic low temperature as upstream
- start with two inference threads, matching upstream examples and reducing heat/power; qualify two versus four on the Pixel before freezing
- if a window reaches the token cap or exceeds the slow-window threshold, checkpoint the outcome and re-plan that window into two shorter overlapping windows rather than increasing the token limit. sherpa's own implementation recommends shortening audio when Qwen bounds are exceeded. [Upstream Qwen3 recognizer](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc)

A Java/Kotlin timeout around `decode()` is not a reliable hard cancellation boundary because the native sherpa call has no exposed cancel API. A genuine hard watchdog therefore belongs around the private ASR process, not around a `Future.get(timeout)` in the same process.

### 4. Practical audio lifecycle

The current retention implementation is incorrect for the requested product: it measures only `transcribed` or `summarized` meetings, so incomplete/transcribing audio does not count toward the 1 GB cap.

Replace it with one policy over **all** Maina recording directories:

1. Never delete the active recording.
2. After transcript blocks and final coverage commit transactionally to Maina's DB, acknowledge the native outbox, verify the meeting is `transcript_durable`, then delete its audio. Cloud sync is not a prerequisite because MKC consumes text, not audio.
3. Keep incomplete/retryable audio for at most seven days, subject to the hard 1 GB global cap.
4. When above 1 GB, evict in this order: completed audio that escaped cleanup; terminal/unrecoverable audio; then oldest incomplete audio. If incomplete audio is evicted, mark the meeting `audio_expired_incomplete` visibly—never pretend transcription completed.
5. Run cleanup after capture finalization, after transcript import, at startup/resume, and as unique periodic maintenance work.
6. Before recording starts, query allocatable space and run cleanup. If the phone cannot safely reserve a reasonable recording buffer, fail before the meeting rather than midway through it. Android says apps must maintain their own temporary-file cleanup and should query available/allocatable space when needed. [Android app-specific storage](https://developer.android.com/training/data-storage/app-specific)

Do not add FLAC/compression in this build. Immediate deletion of completed audio gives more benefit with less CPU, battery, and codec risk.

### 5. Automatic summary and MKC flow

- No clicker or user action is involved after Stop.
- Immediate path while the app is alive: native result -> transactional transcript import -> auto-summary -> frozen MKC payload -> sync.
- Deferred safety path: one Expo BackgroundTask periodically runs import, summary reconciliation, MKC retry/corrections, retention and lightweight diagnostics. This is expected to be delayed by Android; it is a recovery net, not a real-time promise.
- Network failures use exponential backoff. Auth, validation, conflict and budget states remain terminal/actionable according to the existing MKC contract.
- The initial MKC source is frozen only after transcript is durable and auto-summary has either completed or reached a stable failure state. Retries reuse the frozen bytes. Later regenerated notes use the deployed correction-lineage path; they never mutate the original source payload.
- Android force-stop is an explicit boundary: if the user force-stops Maina in system settings, Android will not run its services/jobs again until Maina is opened. The app should report this accurately rather than promise impossible recovery.

### 6. Truthful progress and recording heartbeat

- Recording screen: do not show live transcript copy. Compute RMS/peak from the same PCM buffer already being written and expose a low-rate level sample (about 4–8 updates/second). Drive the existing orb/rings from that value. Never open a second recorder merely for animation.
- Transcription cards: percent is `(completed + terminally failed windows) / total windows`, loaded from the native outbox while the run is active. Display `Processing audio 47 of 216` plus the measured percentage.
- Remove the fabricated 8%/26% progress fallback currently in the home card. If total work is unknown, use an indeterminate animation—not a fake percentage.
- Summary and cloud stages show stage labels/spinners, not percentages, because those calls have no honest sub-progress.
- Only actionable failure notifications should require a tap. Routine stage transitions remain quiet.

### 7. Memory, thermal and concurrency guardrails

- ASR private process; recording/UI process remains light.
- Exactly one recognizer and one ASR job.
- Release recognizer when a meeting completes, when ASR is deferred, and when the media-processing service times out.
- Listen to Android thermal status. At severe thermal status or low battery while unplugged, finish/checkpoint the current window and defer; never interrupt recording.
- Record per-window duration, token count, memory snapshot, thermal state and retry reason. Diagnostics upload failure remains isolated from the pipeline.
- ONNX Runtime documents that thread count/spinning trade latency for CPU/power and that arenas may retain memory for reuse; therefore two-versus-four threads must be measured on this model/device instead of guessed. [ONNX Runtime threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html), [memory behavior](https://onnxruntime.ai/docs/api/python/api_summary.html)

## Build sequence

### Release gate A — week-test essential

1. Durable resumable outbox schema and first-unfinished-window resume.
2. Qwen `128` token limit, adaptive split on truncation/slow completion, two-thread qualification setting.
3. ASR private-process handshake and clean process exit after work.
4. Global audio lifecycle and strict 1 GB accounting across complete and incomplete recordings.
5. Truthful running progress import and removal of fake bar fallback.
6. Native RMS/peak heartbeat animation; remove live-words promise.
7. BackgroundTask recovery coordinator for import/summary/MKC/cleanup.
8. Automated and native unit tests, then one APK only after all checks pass.

### Release gate B — after the week test

- Speaker diarization/voice identity improvements
- audio compression
- NPU/QNN provider experimentation
- model swap or streaming Qwen runtime
- immediate hard process watchdog if bounded Qwen still exhibits unacceptably long windows

These are not required to validate the current product loop and should not be mixed into the reliability release.

## Qualification matrix before week use

Automated:

- outbox resumes from the exact next window without deleting prior blocks
- duplicate starts create one job only
- process death during a window retries only that window
- new recording defers ASR without harming capture
- progress never goes backward and never exceeds 100%
- completed transcript deletes audio only after durable import/outbox acknowledgement
- incomplete audio participates in the 1 GB cap
- cloud retries reuse identical frozen payload bytes
- summary/cloud/diagnostics failures cannot alter capture/transcript state

Real Pixel:

1. 60-minute locked-screen recording; audio/wall gap <= 3 seconds.
2. Stop via clicker; ASR progress visibly advances from persisted window counts.
3. Force-stop ASR process mid-run; reopen/rescheduler resumes without restarting from zero.
4. Start a second recording while ASR is active; capture wins and stays lossless within the accepted route-switch tolerance.
5. Airplane mode after transcript; summary/cloud remain queued; reconnect and verify one MKC source, no duplicate/conflict.
6. Fill synthetic recovery audio beyond 1 GB; verify eviction order and active-recording protection.
7. Verify audio is gone after a durable complete transcript while transcript, summary, todos and MKC source remain.
8. Two-hour soak on charge with memory, thermal, battery, window latency and service-timeout evidence captured.

## Release decision

Do not call the app week-ready solely because it compiles. The minimum release bar is: capture pass, resumable ASR pass, strict retention pass, automatic summary/MKC recovery pass, and one two-hour Pixel soak without UI/process failure.

The architecture above is deliberately modular: capture emits immutable audio chunks; ASR consumes audio and emits transcript blocks; packet generation consumes text; MKC consumes a frozen source/correction package. Replacing the ASR model later changes only the ASR adapter and model pack, not recording, retention, UI, summary, or cloud contracts.
