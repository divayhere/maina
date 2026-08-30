# Test 3 / Test 5 reliability research and correction decision

Date: 2026-08-30  
Status: research recommendation complete; **no corrective build started**  
Scope: Maina Android `0.10.34 (60)` and iOS `0.10.34 (16)`

> Build-decision note: this first research pass is superseded by
> `TEST3_TEST5_NAVIGATION_PREBUILD_REVIEW_ROUND1_2026-08-30.md`. In particular,
> the Android locked-state retry fields were not captured, the current Xcode
> toolchain cannot call the iOS 27 asynchronous submission API, and confidence
> estimates below are not release evidence.

## Executive conclusion

The architecture should not be rewritten. Durable audio, per-window Qwen
checkpoints, one stable meeting identity, server-mediated notes, idempotent
source keys and local-first SQLite all behaved correctly. The failures are
bounded ownership and wake-up defects:

1. iOS did not retain an OS-owned execution assertion for local Qwen work.
2. iOS call recovery waited for a signal the suspended app could receive only
   after foregrounding.
3. Android received the reconnect signal but obeyed a stale future backoff time
   instead of making one immediate, idempotent retry.
4. The generic background worker reports success before detached iOS Qwen work
   actually finishes.

These are incremental reliability corrections. They do not require a new
backend endpoint, a new store, a new token flow, an audio upload, a model
change, or a UI redesign.

## Exact reproduced failures

### Test 3 — calls while recording

Evidence: `M0_TEST3_PHYSICAL_REPLAY_AUDIT_2026-08-30.md` and local artifact
`20260830-080510-test3-call-interruption`.

- iPhone meeting `mtf74exh-7ezcgd`, source-key fingerprint
  `8a360d3f3b9e39f542507f66d6b92d3dad28aad02da1a2a398973becdd4ce530`.
- Answered and rejected call paths paused native capture while locked.
- Neither resumed without opening Maina.
- Final iPhone recording was 2:00 audio across 6:27 elapsed: 4:27 was omitted.
- Opening Maina triggered recovery of the same meeting. No duplicate was seen.
- Pixel meeting `mtf74drr-7z7mvm`, source-key fingerprint
  `02db162797c99de45aa61b7bf5ff94bee6b44f73efc15e0df6a809015c88a0dc`.
- Pixel retained 5:51 audio across 6:18 elapsed and included post-call speech.
  The exact answered/rejected pair is not fully evidenced, so Android Test 3
  remains physically open.

### Test 5 — offline recording, locked recovery and reconnect

Evidence: `M0_TEST5_OFFLINE_RECOVERY_0_10_34_ADDENDUM_2026-08-30.md` and local
artifact `20260830-085309-test5-offline-recovery`.

- Pixel completed `14/14` local windows while locked, but notes/sync did not
  converge until foregrounding.
- iPhone remained `4/14` through locked, online and network-flap checkpoints.
- Foregrounding resumed iPhone at window 4, completed `14/14`, generated notes,
  synced once with HTTP `201`, and cleaned eligible completed audio.
- Both devices ultimately rendered `Notes ready` and `Synced to cloud`.
- This is recoverable state, not autonomous recovery.

## Root-cause model

### R1. iOS continued-processing handler registration does not match the job

Current native code places the wildcard in Info.plist, but also calls
`BGTaskScheduler.register` with that wildcard. It then submits a concrete
per-meeting identifier. Apple's documentation shows the wildcard as the
permitted base and the submitted request as a fully composed identifier. Apple
DTS reports that registering the wildcard is rejected while registering the
concrete instance works.

The code does not persist whether registration, submission and handler attach
actually occurred. It can therefore claim `continued-processing-requested`
while Qwen is running only under the short UIKit fallback. The physical
`4/14` plateau is consistent with that fallback expiring after tens of seconds.

Confidence: **high**, pending one instrumented replay that proves the native
registration/submission/attach sequence.

### R2. The iOS OS worker does not own the asynchronous Qwen lifetime

`launchIOSPostProcessing()` creates and stores a promise, then explicitly
detaches it with `void work` and returns `true`. The OS background task awaits
`reconcilePendingNativeMeetingWork()`, which therefore returns before Qwen is
finished. TaskManager can report success and end the OS assertion while the
actual transcription promise remains in-process and becomes suspendable.

Confidence: **very high** from direct source control flow and the physical
`4/14` -> foreground -> `14/14` sequence.

### R3. iOS call-end delivery is not a guaranteed background wake

On interruption begin, Maina closes the current WAV safely and marks native
state paused. It starts recovery only after interruption-ended, route-change,
or app-active signals. Apple documents that audio-session interruption delivery
can be delayed until the suspended app runs again. That exactly matches both
physical call paths.

A short native recovery watcher started at interruption begin can materially
improve rejected calls and short calls. It cannot make a public iOS guarantee
that an app suspended during an arbitrarily long answered call will wake itself
immediately when the call ends. `CXCallObserver` is useful as a redundant signal
but its documentation does not promise a suspended-process wake.

Confidence: **very high** for the cause; **medium-high** for best-effort
zero-touch improvement; **no honest 100% guarantee** for a long answered call.

### R4. Android reconnect observes the network but filters the job out

The reconnect listener calls the common recovery cycle. That cycle calls
`listMeetingsNeedingSummary(Date.now())`, which excludes `retryable` work until
`cloud_notes_next_retry_at <= now`. An offline failure may set that field far
into the future. In Test 5, connectivity and the periodic worker both ran, but
the query returned zero due meetings.

This is not an idempotency failure and is not primarily the ASR WorkManager
`KEEP` policy. It is the wrong eligibility policy for the special event
“network just became usable.”

Confidence: **very high** from source and device logs.

### R5. UI was not the terminal defect in the current Test 5 run

Once foreground work resumed, iPhone advanced from active progress to terminal
without relaunch. Repeated paired screenshots remained correct. Android Home,
detail, Notes, To-dos and Transcript all rendered terminal state; Transcript
showed 14 blocks and the tabs remained aligned.

Add a regression for background persistence -> foreground terminal refresh,
but do not redesign or add another polling loop based on this run.

## Industry-aligned correction

### P0-A — make iOS local ASR truly OS-owned

1. Register the exact concrete continued-processing identifier immediately
   before submitting its request; keep only the wildcard in Info.plist.
2. Use immediate/fail submission semantics for user-started work so refusal is
   explicit rather than silently queued behind an unknown task.
3. Persist sanitized native states: registered, submitted, attached, expired,
   completed, and fallback reason. Never persist transcript or request ID.
4. Make the OS TaskManager callback await one bounded checkpoint-owning Qwen
   pass. Do not detach the promise from the worker that claims ownership.
5. Report progress to `BGContinuedProcessingTask`; on expiration, finish the
   current window/checkpoint and mark the run deferred.
6. Preserve the existing per-window checkpoint manifest and resume behavior.

Apple explicitly describes `BGContinuedProcessingTask` as foreground-started
work that can continue when the app backgrounds, while still warning that the
system may terminate it under resource pressure. Checkpointing remains
mandatory.

### P0-B — make iOS call recovery best possible and truthful

1. At interruption begin, finalize the current WAV as today and immediately
   start the bounded native recovery assertion/watch—not only after an end
   event.
2. Observe interruption-ended and modern resumption recommendations where the
   installed SDK supports them; retain legacy interruption options behind
   availability checks.
3. Add `CXCallObserver` as a second signal, never as the sole owner.
4. Retry audio-session activation with the existing bounded native delays,
   same meeting ID and monotonically increasing chunk index.
5. Stop all recovery on deliberate Pause/Stop.
6. Add a recording Live Activity with a truthful Recording/Paused state and a
   Resume action using `AudioRecordingIntent`/`LiveActivityIntent` where
   supported. This is the sanctioned one-tap fallback when iOS suspended the
   process; locked-device interaction may require authentication.

Acceptance must be split honestly:

- Rejected call: unattended resume is required.
- Short answered call while background assertion survives: unattended resume
  is required.
- Long answered call after iOS suspends Maina: preserve all pre-call audio,
  show truthful Paused state, and offer one-tap lock-screen resume. Do not claim
  a platform guarantee Apple does not expose.

### P0-C — make reconnect override stale transport backoff once

1. Add an explicit recovery reason to the shared pipeline:
   `startup | foreground | os-background | connectivity-restored`.
2. Only for `connectivity-restored` and the OS recovery worker, include
   retryable **network/server transport** packet jobs even when their previous
   retry time is in the future.
3. Do not include auth, validation, incomplete-ASR, terminal, or user-paused
   work.
4. Reuse the existing meeting-packet job/source key and frozen payload. The
   retry must be exactly-once in effect, not exactly-once transport.
5. Keep the persisted exponential backoff for repeated failures and the
   15-minute periodic worker as the eventual Android fallback.
6. Apply the same shared TypeScript policy to iOS OS wakes; do not invent a
   native mobile backend.

Android's official offline-first guidance recommends a local source of truth,
a persistent queue, connectivity as a queue-drain signal, WorkManager, bounded
backoff and idempotent handling. Maina already has most of this; the correction
changes the wake policy, not the architecture.

### P0-D — make evidence and UI convergence testable

1. Make the dual-device harness own monitors with durable process groups and
   fail preflight if PID/log growth stops.
2. Keep sanitized state snapshots at recording, stop, locked processing,
   reconnect, flap, terminal and +5/+10 minutes.
3. Add a focused UI regression: a persisted terminal pipeline change must
   update Home and open detail after foreground without closing/reopening.
4. Keep current terse states. Do not add raw errors, hostnames, retry internals
   or more home-page narration.

## Stitching and duplicate-safety analysis

The changes handshake safely if ownership remains explicit:

1. Native recorder owns durable WAV chunks and call/route continuity.
2. One iOS continued-processing/Android native worker owns local Qwen at a
   time; SQLite windows make replay idempotent.
3. Shared TypeScript owns transcript eligibility and the cloud outbox.
4. MKC owns prompt/provider execution; clients keep the unchanged
   `mkc.meeting-packet.v1` contract.
5. One immutable source key per meeting makes repeated HTTP attempts safe.
6. Pipeline change signals refresh UI from SQLite; event payloads do not become
   a second state store.

The correction must not add parallel retry loops. The network listener and OS
worker may both request a drain, but the existing in-flight promise and stable
keys must serialize them. Focused tests must deliberately fire foreground,
network and worker signals together and prove one effective packet/source.

## Build and qualification order

1. Fix the harness and add source-level tests first.
2. Implement shared reconnect-reason and idempotency tests once in TypeScript;
   prove byte parity across both branches.
3. Implement iOS exact-ID continued processing and awaited ownership.
4. Implement iOS call recovery signals and Live Activity fallback.
5. Run focused tests, full tests, typecheck, lint, native recorder verification,
   contract/coordination gates and diff audit.
6. Send the review package to Maina Admin. Do not build before approval.
7. Build one data-preserving Android candidate and one iOS candidate.
8. Install in place; never uninstall or clear data.
9. Replay Test 3 and Test 5 with screenshots/logs/DB evidence.
10. Admin independently runs the final dual-device freeze qualification.

## Required automated tests before a build

- iOS concrete identifier registration and sanitized attach/submission states.
- Background task does not complete while Qwen ownership promise is running.
- Expiration preserves the completed-window checkpoint and returns deferred.
- Deliberate Pause/Stop cancels call recovery; system interruption does not.
- Reconnect bypasses future retry time once for transport errors only.
- Auth/validation/incomplete-ASR work remains excluded.
- Simultaneous network/foreground/worker signals produce one effective packet
  and one immutable source.
- Network flap retains the same job ID, payload hash and source key.
- Terminal DB state refreshes Home/detail without relaunch.
- Recording, ASR partial coverage, audio cleanup, corrections, To-dos, sharing,
  and all Memory feature flags remain unchanged/default-off.

## Physical acceptance after the single build cycle

### Test 3

- Answered and rejected calls on both exact devices.
- Screen locked; no Maina foregrounding and no Retry tap.
- Native/visible Recording-Paused state and timers agree.
- Same meeting identity; no call audio; post-call speech present.
- Rejected/short-call iOS resumes unattended; long-call fallback is visible and
  one-tap from the lock-screen surface if iOS suspended the process.
- Stop/save -> terminal ASR -> notes -> one immutable sync.

### Test 5

- Offline recording and stop on both phones.
- Keep locked while ASR runs.
- Restore connectivity, apply one short network flap, never foreground Maina.
- Android reaches notes/sync using connectivity/WorkManager.
- iPhone finishes via continued processing or a genuine OS worker wake.
- Same packet/source identity and frozen payload; no duplicate.
- Only after terminal evidence, foreground and verify immediate truthful UI.

## Residual limits after correction

- iOS may terminate continued processing under resource pressure; durable
  checkpoints and later OS wake remain required.
- Swiping Maina away intentionally cancels Apple background work.
- Expo periodic background tasks are discretionary; they are an eventual
  fallback, not a real-time scheduler.
- A long answered call can outlive iOS's available background assertion. Public
  APIs cannot support an honest promise of zero-touch microphone restart in all
  suspended states.
- Local Qwen speed remains device-dependent; reliability is the target, not
  instant completion.

## Decision

Proceed with this bounded correction after Admin review. Confidence that it
materially improves both apps without degrading the current local-first
architecture: **92%**. Confidence that iPhone can guarantee unattended resume
after every arbitrarily long answered call: **below 60% because the platform
does not provide that guarantee**. The correct product promise is durable audio,
best-effort auto-resume, and a truthful lock-screen one-tap fallback.

## Primary references

- Apple: [BGContinuedProcessingTaskRequest](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest)
- Apple: [Performing long-running tasks](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados)
- Apple: [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
- Apple: [AVAudioSession interruption notification](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification)
- Apple: [AudioRecordingIntent](https://developer.apple.com/documentation/appintents/audiorecordingintent)
- Apple: [Interactive Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities)
- Apple DTS: [continued-processing registration/submission discussion](https://developer.apple.com/forums/thread/807370)
- Android: [Persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent)
- Android: [Managing unique work](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work)
- Android: [Offline-first data layer](https://developer.android.com/topic/architecture/data-layer/offline-first)
- Expo: [BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/)
