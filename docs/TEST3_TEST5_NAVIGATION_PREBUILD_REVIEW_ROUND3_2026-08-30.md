# Test 3, Test 5, navigation and refresh — pre-build review round 3

Date: 2026-08-30

Decision: **NO-GO for product-code implementation, release artifacts, install,
promotion, or owner approval**

Allowed action in this round: documentation and primary-source research only.

This document supersedes Round 2. It reconciles the proposed correction with
the canonical physical report at
`/Users/divay/Developer/Maina/qualification/2026-08-29-dual-device/REPORT.md`.
No finding F-001 through F-014 is omitted or inferred from a different build.

## 1. Frozen boundary and evidence identity

Accepted Backend/Web inputs:

- Backend source: `6b2bcf43c2e8c4fb7c40a6cb6fb49e643099f93b`.
- Backend deployed runtime: `d6d67e1`.
- Web source: `5b11bb026ff5fff36c7b393add9c0c64986a1335`.
- Web deployed runtime: `ec44286`.
- `57cbb52fdefe902f985ed9eaca57c6be5cb7ee5f` was an earlier frozen-recall
  contract-publication correction. It is historical evidence, not the Apps
  freeze input and not a runtime pin.

Physical evidence boundaries:

- The canonical five-test report used iOS `0.10.28 (11)` and Android
  `0.10.30 (56)` and owns findings F-001 through F-014.
- Later installed candidates are iOS `0.10.34 (16)` and Android
  `0.10.34 (60)`. Later source contains partial recovery corrections, but those
  candidates do not close a canonical finding without an exact physical replay.
- Android's current `MainaCallInterruptionPolicy` is therefore unqualified
  implementation, not evidence that F-010 is fixed.
- The current iOS owner files `ios-tests/MainaUITests.swift` and
  `scripts/stop-dual-device-soak.sh` remain user-owned and must not be lost.

This proposed Apps correction changes no Backend/Web endpoint, schema, source
key, packet, provider, prompt, credential, tenant, datastore, retrieval logic,
or deployed implementation. It adds no mobile retrieval engine or cloud retry
contract. `mkc.meeting-packet.v1` remains unchanged.

## 2. Round 3 release contents

### Required for this build

1. Test-harness monitor survival and exact-device preflight.
2. iOS unique continued-processing submission lifecycle and one completion
   owner.
3. Persisted ASR generation/claim fencing against late decode commits.
4. iOS bounded call-interruption recovery plus truthful partial terminal state.
5. Android typed call/communication pause-resume state machine.
6. Monotonic capture duration, gap, disposition, and terminal heartbeat state.
7. Typed cloud transport failures and safe user-message mapping.
8. Android durable network wake with a proved public Headless JS boundary.
9. iOS app-specific network-constrained BGProcessing wake.
10. SQLite-driven UI convergence without polling or foreground tricks.
11. Event-driven verified audio cleanup and coalesced retention scans.
12. Narrow native Back/history correction and local-only pull-to-refresh.
13. Resource-plateau, data-preservation, duplicate-work, and physical gates.

### Explicit exclusions

- Live Activity or `AudioRecordingIntent` lock-screen control.
- Any custom right-to-left “forward” swipe.
- Android predictive-back animation; destination correctness is required.
- Per-tab navigation redesign or moving all auxiliary routes.
- iOS 27-only asynchronous submission API while the installed SDK is 26.5.
- Exact alarms, unbounded polling, a second outbox, or a native copy of the
  TypeScript packet/source contract.
- Backend/Web, auth, token, prompt, provider, or Memory contract changes.
- Repair of the historical 2026-08-27 04:24 zero-window orphan.
- A new ASR model or a route-specific transcription workaround for F-007.

## 3. Direct source gaps

| Area | Current source evidence | Required correction |
| --- | --- | --- |
| Android call policy | `MainaCallInterruptionPolicy.kt` uses raw `2/3`, two booleans, and `MainaRecordingService.kt` polls every 500 ms | Typed callback-fed state; persistent pause reason/generation; exact constants; physical WhatsApp proof |
| Android recording callback | `MainaRecordingService.kt` observes `isClientSilenced` but the canonical test captured call-side speech | Treat silence and communication mode as coalesced system-ownership signals; do not equate source presence with safety |
| iOS call recovery | `MainaIOSNativeAudioCapture.swift` starts its fixed retry chain after interruption end and exhausts to “reopen Maina” | Begin one bounded watcher at interruption begin and keep it alive only under granted background time |
| iOS heartbeat/duration | `record.tsx`, `_layout.tsx`, and startup reconciliation can outlive native terminal state and apply wall metrics | Persist capture truth once; terminalize heartbeat/modal; monotonic merge only |
| iOS continued work | `MainaIOSContinuedProcessing.swift` derives/reuses one meeting ID, registers wildcard at runtime, and has competing completion paths | Per-submission ID, exact registration, persisted registry, one completion gate |
| Detached iOS work | `meetingCaptureLifecycle.ts` stores a Promise, executes it with `void`, and returns Boolean | Shared completion handle; OS owner awaits the same run |
| ASR callback | Sherpa decode is synchronous and window commit occurs afterward | Persisted run generation plus claim token/CAS commit fence |
| Cloud errors | `mainaCloudFetch` can wrap `cause.message`; `meetingPacket.ts` renders `MainaCloudApiError.message`; MKC source sync stores raw fetch message | Machine classification and fixed safe display copy; bounded sanitized diagnostics only |
| Test 5 wake | Expo BackgroundTask is one inexact 15-minute worker; process-alive listeners are not process-death recovery | Android unique Worker proof; iOS registered network-constrained processing request |
| Work enqueue | Durable state commit and WorkManager enqueue are not atomic | `pipeline_wake_state` is scheduling truth; startup/periodic reconciliation repairs the crash window |
| Cleanup | retention recursively scans all audio at startup/pipeline completion and F-001 still retained terminal iOS WAVs | Per-meeting terminal cleanup event, verified delete, pointer clear after proof; coalesced fallback scan |
| Navigation | meeting/recovery are hidden tabs; Record Save replaces over old meeting history; drawer pushes duplicates | Outer detail/recovery only; native history; atomic save/delete reset |

## 4. Test 3 — Android call privacy state machine

### 4.1 Why the current policy is insufficient

Android documents `AudioRecordingConfiguration.isClientSilenced()` as a
framework concurrency signal, not a universal “a call exists” signal. Android
also exposes `AudioManager.OnModeChangedListener` from API 31 for typed
`MODE_RINGTONE`, `MODE_IN_CALL`, `MODE_IN_COMMUNICATION`, redirect, and normal
changes. The Pixel target is above API 31, so polling and numeric literals are
unnecessary as primary ownership.

WhatsApp/other VoIP apps normally use communication audio mode, but that is not
a cross-device guarantee. `isClientSilenced` may remain false while the app is
still receiving the user's microphone, exactly as F-010 demonstrated. The
combination is a defensible implementation; only physical WhatsApp, telephony,
and another VoIP replay on the pinned Pixel can prove the product behavior.
Remote-party capture was never proven and must not be claimed.

### 4.2 Native states and signals

Persist one capture owner state in the native journal and mirror only durable
transitions to SQLite:

```text
idle
  -> recording
  -> manual_paused
  -> system_pause_pending(reason, generation)
  -> system_paused(reason, generation, gapStartedAt)
  -> system_resume_pending(generation)
  -> recording(newChunk, sameMeeting)
  -> terminal_complete | terminal_partial
```

Typed inputs:

- own-session `AudioRecordingCallback` configuration and
  `isClientSilenced`;
- `OnModeChangedListener` values, using Android constants, not `2/3`;
- communication-device changes as a coalescing hint, never sole call proof;
- explicit user Pause, Resume, Stop, Abort;
- service/process restoration against the durable capture journal.

`MODE_RINGTONE`, call, communication, call-screening, and redirect modes request
a system pause. This privacy-first choice can omit ringtone time but cannot
record a user's answered-call speech. `MODE_NORMAL` requests resume only after
750 ms of stable normal/unsilenced state. Callbacks enter one serial reducer;
each carries the current generation. Duplicate and stale callbacks are no-ops.
A low-rate snapshot may diagnose missed OEM callbacks but must not own a second
pause/resume loop.

### 4.3 Transition rules

On the first system-pause request while recording:

1. Increment generation and mark `system_pause_pending`.
2. Stop accepting PCM into the active chunk.
3. Flush/finalize/fsync that chunk and journal the boundary.
4. Persist `pause_reason=system`, captured-audio duration, and gap start.
5. Publish Paused only after the chunk is durable.

Manual Pause is independent. A user Pause during a system interruption changes
the durable reason to manual and permanently disables auto-resume for that
generation. Stop/Abort invalidates all callback generations before finalizing.

On stable audio ownership:

1. Verify the same meeting is active and pause reason is still system.
2. Activate/configure `AudioRecord` successfully.
3. Open a new monotonic WAV chunk in the same meeting.
4. Start capture, persist cumulative gap, then publish Recording.

No chunk is opened before audio ownership succeeds. Failure uses bounded
1/2/4/8/15-second attempts while the microphone foreground service remains
valid. Exhaustion ends once as `terminal_partial`, preserves every durable
chunk, stops the heartbeat, and presents a recoverable partial meeting. It does
not pretend to be recording.

Process restoration reads the journal. It may resume only an active meeting
whose last durable reason is system and whose communication state is normal;
otherwise it remains safely paused/partial. No permission-based phone-state
heuristic and no call-audio capture permission is added.

### 4.4 Android Test 3 gate

On the exact Pixel/build, using transcript markers before/during/after:

- rejected call, 5–15 seconds;
- answered telephony call, 15–25 seconds;
- answered WhatsApp call, 15–25 seconds;
- answered WhatsApp call, two minutes, phone locked;
- user manually pauses during a call;
- Stop during a call.

Every accepted path must retain one meeting ID, finalize separate chunks, show
native/UI state agreement, contain zero marker text spoken during the call,
contain post-call speech, and create one ASR/notes/source lineage. The rejected
path may lose ringtone time by design. WhatsApp failing to produce a sufficient
signal is a release blocker and requires a revised native signal strategy; it
does not authorize UI-text heuristics or a claim that the remote party was
captured.

## 5. Test 3 — iOS recovery, heartbeat, and duration truth

### 5.1 Call watcher

The Round 2 coalesced watcher remains required:

- interruption begin finalizes the active chunk, increments one generation,
  records the gap start, enters system-paused, and requests one UIKit background
  assertion;
- interruption-ended, route change, resumption recommendation,
  `CXCallObserver`, and app-active only set `probeRequested` on that watcher;
- at most one activation attempt per second while
  `UIApplication.backgroundTimeRemaining > 3` seconds;
- configure session and `setActive(true)` must succeed before a new chunk is
  opened;
- deliberate Pause/Stop/Abort invalidates the generation, timers, and assertion;
- expiration ends the assertion synchronously and leaves a truthful durable
  partial state rather than claiming automatic recovery.

Rejected 5–15-second and answered 15–25-second calls must resume unattended
within five seconds with no call marker and with post-call speech. The locked
two-minute answered-call case has the same acceptance. There is no Live
Activity mitigation in this build. If the long locked call requires
foregrounding, Test 3 remains FAILED and promotion remains NOT READY unless the
owner explicitly changes the acceptance criterion.

### 5.2 Persisted capture truth

Append the following fields in the same additive mobile migration used by this
increment:

```text
meetings.capture_disposition
  active | complete | partial_system_interruption | partial_capture_failure |
  aborted | null
meetings.capture_pause_reason
  manual | system | null
meetings.capture_gap_ms INTEGER NOT NULL DEFAULT 0
meetings.capture_heartbeat_terminal_at INTEGER
```

Existing fields keep strict meanings:

- `audio_duration_ms`: monotonic sum of verified finalized native WAV/journal
  durations. Once nonzero it cannot become zero because files were cleaned or
  native metrics are absent.
- `duration_ms`: recorded-audio duration for existing presentation
  compatibility; never wall elapsed after relaunch.
- `capture_ended_at`: native terminal boundary; never `Date.now()` during a
  later startup repair.
- `capture_gap_ms`: interruption/route-unavailable duration only.
- `capture_disposition`: whether capture completed or is genuinely partial;
  pipeline/summary status does not erase this evidence.

Startup reconciliation performs a transactionally monotonic merge:

```text
audioDuration = max(storedMeasured, nativeMeasured, sumFinalizedChunks)
duration = audioDuration
captureEndedAt = first durable native terminal boundary
gap = max(storedGap, nativeJournalGap)
```

It may fill unknown values but may not replace measured audio with wall time,
clear known duration, move `capture_ended_at` forward, or regress terminal ASR/
notes/source state to `interrupted`. Audio cleanup must first persist measured
duration and disposition.

### 5.3 Heartbeat and modal terminalization

One terminal reducer observes native terminal capture plus durable pipeline
state. When ASR reaches ready/accepted partial and notes/source are terminal or
durably deferred:

1. invalidate the recording heartbeat and active-session reference;
2. persist `capture_heartbeat_terminal_at`;
3. replace/dismiss the stale recovery route;
4. open meeting detail with `Partial recording · 1:23 captured` when capture is
   genuinely partial, or normal detail after successful resume;
5. keep cloud waiting/retry presentation independent from recording state.

No modal can remain above a meeting whose durable ASR, notes, and source stages
are terminal. Successful resumed capture ends `complete` and retains the gap as
diagnostic metadata; genuinely cut-short capture remains partial without fake
wall duration.

Tests cover the exact F-011 shape: 82.777-second native evidence, process
relaunch much later, removed audio directory, terminal 6/6 ASR, notes/source
ready. It must still render 1:23, nonzero audio duration, original terminal
boundary, terminal heartbeat, and partial disposition after repeated reloads.

## 6. iOS continued processing and late-decode fence

### 6.1 Per-submission identity

Each foreground user-started ASR run allocates and persists:

```text
submissionId = prefix + meetingHash16 + runSequence + uuid16
submissionId -> meetingId, runSequence, asrGeneration, lifecycle, timestamps
```

The exact ID is registered before submission; the Info.plist wildcard is only
permission. A process ledger prevents duplicate registration. A repeated begin
for the same active run returns the same completion handle; a retry allocates a
new ID and never resubmits a completed one. Nonterminal records are bounded to
8, sanitized seven-day tombstones to 64, and process registrations to 64.
Two meetings can own records, while Qwen remains globally serialized. At
launch, persisted nonterminal IDs are registered before React Native, reconciled
with scheduler pending requests, and never blindly resubmitted.

The installed SDK supports synchronous `submitTaskRequest(_:error:)`; its error
is persisted. The iOS 27 completion-handler/async API is deferred until its SDK
is actually installed.

### 6.2 One execution owner and expiration

`launchIOSPostProcessing` returns an `IOSPostProcessingHandle` containing one
completion Promise. Foreground callers start it without awaiting; a generic OS
worker awaits the same in-flight completion. A `BGContinuedProcessingTask`
monitors that engine and never starts a competing run. Background recovery
never submits a new continued-processing request.

The native task has one `CompletionGate`. Normal finish, cancellation,
expiration, RN claim timeout, and cleanup all call `completeIfOpen`; only one
can invoke `setTaskCompleted`.

If RN does not claim a delivered task within 10 seconds, native persists a
sanitized deferred record, completes false once, and releases all handles. On
expiration, native requests JS deferral and starts a one-second fail-safe. If
Sherpa cannot cancel its synchronous in-flight window, native completes false
promptly; it never waits for a promised checkpoint. Duplicate computation of
one window is acceptable, duplicate transcript commitment is not.

### 6.3 Persisted generation/claim fencing

Extend `local_asr_windows` or add a companion claim table with:

```text
meeting_id, window_key, asr_generation, claim_token, claim_state,
claimed_at, lease_until, committed_at
```

Rules:

1. Starting/recovering a run obtains a durable meeting generation.
2. Before decode, a SQLite transaction claims a pending/replayable window and
   returns a random claim token.
3. Expiration marks the run deferred and advances/invalidates the generation;
   the in-flight window remains replayable.
4. A callback commits transcript/checkpoint only with a compare-and-set on
   meeting generation + window key + claim token + uncommitted state.
5. A late callback whose generation/token lost ownership writes nothing and
   cannot advance progress or queue notes.
6. The later valid recovery commit wins once under existing unique transcript
   indexes.

Forced-order test:

```text
run A claims -> decode blocks -> OS expires -> generation invalidated
-> run B claims and commits -> run A returns -> CAS affects zero rows
```

Qwen serialization limits CPU overlap but is not accepted as the ownership
fence.

## 7. Test 5 — typed durable cloud recovery

### 7.1 Shared failure state and safe copy

Append machine-only fields:

```text
meetings.cloud_notes_failure_class
  offline | dns | tls | socket | timeout | http_retryable | http_terminal |
  backend_retryable | backend_terminal | auth | protocol |
  transport_unknown | null
meetings.cloud_notes_failure_operation
  create | poll | provider_retry | null
meetings.cloud_notes_last_wake_epoch INTEGER

pipeline_wake_state (single scheduling-truth row)
  connectivity_epoch, last_connected, last_claimed_epoch,
  pending_wake_token, enqueue_required, enqueued_work_id,
  requested_at, updated_at
```

Classification uses disconnected state, HTTP status, backend machine code,
`Error.name`, and structured `cause.code`; it never parses user-facing text.
DNS/TLS/socket distinctions are used only when the runtime provides a typed
code. Unknown fetch rejection is `transport_unknown`.

Display copy is a closed mapping:

| Class | User copy |
| --- | --- |
| offline/dns/tls/socket/timeout/transport_unknown | `Waiting for internet. Maina will continue automatically.` |
| auth | `Reconnect Maina Cloud. Your recording and transcript are safe.` |
| 408/425/429/5xx/backend retryable | `Maina Cloud is temporarily busy. Maina will retry automatically.` |
| validation/protocol/backend terminal | `Cloud notes need attention. Your recording and transcript are safe.` |

No UI, notification, accessibility label, or persisted display field may expose
an exception class, hostname, URL, token, provider response, or raw server text.
Bounded local diagnostics retain only operation, class, status, machine code,
attempt, and timestamps; raw cause text/URL/body is dropped before logging.

### 7.2 One-shot operation semantics

One SQLite compare-and-set claims `(meeting, connectivityEpoch, operation)`:

- no job ID + transport failure: create once with the stable source/packet key;
- existing job ID + transport failure: poll that same job once;
- provider/backend retryable: obey `nextRetryAt`; reconnect cannot bypass 429 or
  provider backoff;
- auth, protocol, terminal, or incomplete ASR: no automatic cloud action.

Concurrent NetInfo, foreground, native worker, and Expo periodic signals claim
one epoch. A real failed operation increments retry accounting once. Source
sync continues to use its existing frozen payload/stable source-key outbox.
There is no second outbox or native packet implementation.

### 7.3 Android process-death wake and enqueue crash window

Use a tiny app-owned WorkManager `CoroutineWorker` that invokes the public React
Native `HeadlessJsTaskService`, which calls the existing shared TypeScript
`runPipelineRecoveryCycle`. Direct invocation of Expo's private worker remains
rejected. Unique name is versioned, policy is `KEEP`, and constraint is
`NetworkType.CONNECTED`.

Headless JS is a hard pre-release-artifact proof gate. An instrumentation test
must show, after process death, Worker creation, named JS task start on RN
0.86.3, one shared recovery call, and completion returned to WorkManager. If
that public path cannot run reliably without another foreground service,
restricted launch, Expo internal, or broader permission, implementation stops
with NO-GO and the plan is revised. It must not silently adopt those options.

The DB/enqueue crash window is reconciled as follows:

1. The same transaction that persists retryable state sets
   `pipeline_wake_state.enqueue_required=1` and a wake token.
2. Enqueue is attempted after commit.
3. Successful enqueue records its work ID but does not clear scheduling truth.
4. The Worker atomically claims the current epoch and clears `enqueue_required`
   only after it owns the shared cycle.
5. App/native process start, foreground reconciliation, and the already
   registered persistent Expo periodic safety-net inspect the row and repair a
   missing enqueue.
6. Existing WorkManager persistence restores enqueued work after reboot; if
   death occurred before enqueue, the persistent periodic worker or next
   process start repairs it. No exact immediate reboot guarantee is claimed.

Fault injection must kill after DB commit/before enqueue, then prove one
eventual Worker after process restart and, where the existing periodic request
survives reboot, after reboot. Stable job ID, packet hash, source key, epoch,
and retry count must remain singular.

### 7.4 iOS network-constrained wake

Options:

| Option | Property | Decision |
| --- | --- | --- |
| Existing Expo BackgroundTask | Shared, inexact, minimum 15 minutes; no app-owned network requirement | Keep as eventual safety net |
| Still-live BGContinued task | Useful only while user-started ASR assertion remains alive | Fast path only; not Test 5 owner |
| App-specific `BGProcessingTaskRequest` | Supported; can require network and relaunch main app | **Selected** |

Add one static permitted identifier such as
`com.divay.maina.staging.pipeline-network-recovery`. Register its launch handler
before the end of app launch. When a foreground/active run commits durable
transport failure, submit one request with
`requiresNetworkConnectivity=true`; resubmission of the same pending static ID
replaces the request. The handler waits for the same shared TypeScript cycle,
sets an expiration handler, completes exactly once, and resubmits only when
durable eligible work remains. It never creates a BGContinued request from the
background.

Apple controls launch timing and explicitly warns that scheduled background
work can be delayed for many hours. The truthful guarantee is:

- local audio/transcript and retry state survive indefinitely;
- work becomes eligible when connectivity and OS policy allow;
- a process-alive continued task or network listener is a fast path;
- app-specific BGProcessing plus Expo periodic/foreground are eventual paths;
- immediate post-reconnect completion is not guaranteed by iOS.

Product qualification nevertheless sets a measurable target: on the powered,
locked iPhone 15, three consecutive offline captures—including one terminated
process and one network flap—must converge without opening Maina or tapping
Retry within 30 minutes of stable connectivity. If any exceeds 30 minutes,
Test 5 and promotion remain NOT READY even though the work is still durable.
The test records OS delivery time separately from pipeline time.

## 8. Terminal UI convergence, refresh, and notifications

Every pipeline transaction emits a meeting-ID hint after commit. Screens reload
canonical SQLite projections; events carry no state and start no work.

- Detail, Home, To-dos, and Notifications subscribe to relevant committed
  meeting signals and converge without relaunch.
- Terminal notes and source-sync state must replace stale “Only on this phone”
  and progress cards from persisted SQLite.
- Notifications use the same safe failure-copy mapping and clear/resolve when
  canonical state is terminal.
- No screen polling loop is introduced.

Pull-to-refresh is local-only and activates only when the vertical scroll view
is at its top:

- Home and To-dos keep their existing `RefreshControl`.
- Detail and Notifications gain local projection reload only.
- Memory remains default-off and gets no background polling; its later enabled
  refresh remains local/cache-bound.
- Settings, Help, Diagnostics, Recording, recovery/destructive forms do not get
  pull-to-refresh.

`reloadLocalState()` is separate from `maybeAdvancePipeline()`. A gesture can
never create/poll/retry a cloud job, reset backoff, restart Qwen, mutate a wake
epoch, or duplicate source sync. Success/failure always ends the indicator and
has an accessible state.

Tests swipe at top and mid-scroll on both platforms, start a horizontal gesture
over Notes/To-dos/Transcript, and use iOS edge-Back/Android system Back. Pull
must not steal horizontal tab interaction or an edge-Back gesture; mid-scroll
must not refresh. Repeated refresh produces zero job, outbox, retry, window,
source-key, and wake-state deltas.

## 9. Navigation — concrete owner behavior

A left-to-right iOS edge gesture is native **Back**, not “always Home.” Android
system/button/predictive Back follows the same logical history. A meeting opened
from To-dos or Notifications returns to that meaningful origin. A newly saved
recording, orphan route, reload without valid predecessor, or deep link falls
back to Home. Back must never expose an older unrelated meeting. No custom
right-to-left forward gesture is added.

The smallest coherent correction moves only meeting detail and recovery from
hidden tabs to the outer native Stack. Recording remains the root modal.
Settings, Help, Diagnostics, Notifications, and Memory stay structurally stable;
moving them would widen a reliability build without fixing the reproduced
history defect. Meeting detail hides the bottom tab bar as a focused detail
screen.

Use Expo Router native Stack and only supported imports:
`useNavigation` from `expo-router`, `CommonActions` from
`expo-router/react-navigation`, plus router `navigate/replace/dismissTo`.

| Screen/event | Entry | Back/gesture destination | Fallback | History mutation |
| --- | --- | --- | --- | --- |
| Home | launch/tab/drawer/fallback | OS root | Home | tab navigate/root |
| To-dos | tab/drawer | prior meaningful screen | Home | singleton tab navigate |
| Meeting detail | Home card | Home | Home | outer push |
| Meeting detail | To-do | To-dos | Home | outer push with origin |
| Meeting detail | Notification | Notifications | Home | outer push with origin |
| Meeting detail | saved Record | Home, never old meeting A | Home | root reset to Home + detail |
| Meeting detail | deep link/orphan/reload | Home | Home | anchored root + detail |
| Recovery | interrupted card/detail/deep link | valid origin | Home | push |
| Recovery Keep/Open | recovery | origin after saved detail | Home | replace recovery with detail |
| Recording Cancel | mic/hardware | true valid origin | Home | modal dismiss |
| Recording Save | any screen | detail B; next Back Home | Home | atomic root reset |
| Delete terminal | detail | Home; deleted route inaccessible | Home | commit then root reset |
| Notifications | bell/drawer | valid predecessor | Home | singleton navigate |
| Memory | enabled drawer | valid predecessor | Home | singleton navigate |
| Settings | drawer | valid predecessor | Home | singleton navigate |
| Help | Settings | Settings | Home | push |
| Diagnostics | Settings | Settings | Home | push |
| Home/To-dos reselect | tab | selected tab root | Home | reset selected tab only |

Required reducer/router and physical tests:

1. Home -> A -> Back = Home.
2. To-dos -> source meeting -> Back = To-dos.
3. Notifications -> meeting -> Back = Notifications.
4. A -> Record -> Save B -> Back = Home, never A.
5. Recovery -> saved detail -> Back resolves origin/root without stale recovery.
6. Delete -> Home; no gesture returns to deleted route.
7. Deep-link meeting -> Back fallback Home.
8. Repeated drawer navigation creates no duplicate history.
9. iOS interactive pop, Android system Back, and header Back agree.
10. Tab reselect cannot resurrect a hidden meeting stack.
11. Pull-to-refresh and horizontal tabs do not conflict with native edge Back.

## 10. F-001 cleanup, F-003 scan efficiency, and F-005 resources

### 10.1 F-001 verified terminal cleanup

After complete durable transcript coverage (including a verified completed
no-speech result), enqueue one in-process per-meeting cleanup operation. Cloud
notes/source state is not a dependency because neither operation needs audio.
The cleanup calls the native directory deletion bridge, verifies nonexistence,
and only then clears `audio_uri` in SQLite. Failure retains the pointer and
writes a typed cleanup retry due-time; it never hides retained audio. Partial or
recoverable transcription keeps audio under the 7-day/1 GB policy so the user
can still request re-transcription.

Acceptance on iPhone repeats the Test 1, Test 2, and Test 4 terminal shapes:
audio directory absent and pointer null within 60 seconds of eligible terminal
state, still correct after relaunch, with measured duration/capture disposition
preserved. Delete failure must retain both pointer and diagnostic retry state.

### 10.2 F-003 coalesced fallback scans

`enforceAudioRetentionPolicy` becomes a single-flight, reason-tagged fallback.
Mounted screens do not recursively rescan all audio. Terminal cleanup handles
the specific meeting; startup, daily/size-pressure, and explicit diagnostics
may request one coalesced full scan. Tests fire simultaneous startup, terminal,
signal, and foreground requests and prove one full scan plus per-meeting cleanup
without repeated filesystem traversal.

### 10.3 F-005 resource gate

F-005 is not closed by “the app did not terminate.” A release-signed iPhone 15
soak must process at least 60 minutes or 120 windows of representative local
Qwen audio while locked/charging and record bounded process footprint, thermal
state, CPU diagnostics, jetsam/watchdog reports, completion, and recognizer
release.

Acceptance:

- no jetsam, watchdog, `cpu_resource` termination action, or stalled window;
- after warm-up, three consecutive 10-window rolling peaks may not show a
  monotonic increase greater than 10% per bucket;
- within two minutes of recognizer release, footprint returns to within 20% of
  the pre-ASR post-model baseline or within 300 MB of it, whichever is larger;
- a second 30-minute run does not begin above the first run's post-release
  baseline by more than 10%;
- transcript checkpoints and app responsiveness remain intact.

These are Maina qualification thresholds, not Apple guarantees. If the gate
fails, promotion stops. Thread count, autorelease pools per window, explicit
ONNX/Qwen disposal, or isolated processing are investigated in a new reviewed
increment rather than silently added to this one.

## 11. File-level change map after approval

Test/documentation:

- `scripts/m0-replay-harness.sh` — exact targets, supervised PIDs, no
  `--terminate-existing`, log-growth fail-fast, timed screenshots.
- preserve/review `scripts/stop-dual-device-soak.sh` and
  `ios-tests/MainaUITests.swift` without overwriting owner edits.
- physical evidence addenda versioned by installed build and meeting/source
  fingerprint; never mix old and new counts.

Shared TypeScript/SQLite:

- `src/data/db.ts`, `src/data/meetings.ts` — one additive migration for capture
  truth, typed failures/wake truth, ASR claim fencing, cleanup retry state.
- `src/core/recording/nativeCaptureReconciliation.ts`,
  `src/services/meetingPresentation.ts` — monotonic merge and truthful labels.
- `src/services/meetingCaptureLifecycle.ts` — completion handle, terminal
  heartbeat/modal reducer, generation ownership.
- `src/services/backgroundPipeline.ts`, `backgroundPipelineCore.ts` — one
  shared cycle and native completion bridge.
- `src/services/mainaCloudSession.ts`, `cloudRetryPolicy.ts`,
  `meetingPacket.ts`, `mainaKnowledgeCloud.ts` — typed transport state,
  operation/epoch claims, safe UI copy, existing contract only.
- `src/services/audioRetention.ts`, `audioRetentionCore.ts` — targeted verified
  cleanup and coalesced scan.
- `src/services/meetingPipelineSignals.ts` — after-commit hint semantics.
- `src/app/_layout.tsx`, Home, To-dos, Notifications, meeting detail/recovery,
  `record.tsx`, `src/design/shell.tsx`, new `navigationPolicy.ts` — convergence,
  refresh split, narrow outer Stack, reset/singleton behavior.

iOS native/config:

- `modules/maina-recorder/ios/MainaIOSContinuedProcessing.swift` — unique
  submissions, exact registration, mapping, claim timeout, one completion gate.
- `MainaIOSNativeAudioCapture.swift` — coalesced call watcher and journal truth.
- `MainaRecorderModule.swift` / TS bridge — completion, generation, deferred
  processing, cleanup signals.
- `plugins/withMainaIOSContinuedProcessing` — exact static network-processing
  identifier, launch registration, background-processing capability; wildcard
  remains only for continued IDs in Info.plist.

Android native/config:

- `MainaCallInterruptionPolicy.kt` — typed reducer.
- `MainaRecordingService.kt` / `MainaNativeAudioCapture.kt` — callback ownership,
  chunk finalization, persisted system pause/resume.
- new `MainaPipelineRecoveryWorker.kt`,
  `MainaPipelineHeadlessService.kt`, and typed native bridge — scheduling only.
- module manifest/config plugin — Worker/Headless service registration without
  new restricted permission.

No Backend/Web files change.

## 12. Automated and physical test matrix

Before release artifacts:

- database migration from schema 15 with unchanged meeting/transcript/todo/
  outbox counts;
- Android call reducer callback coalescing, manual/system separation, durable
  chunk boundary, exhausted fallback;
- iOS watcher simultaneous signals, background-time expiry, deliberate
  Pause/Stop cancellation;
- continued IDs, exact registration, two meetings, bounds, late delivery,
  claim timeout, exactly-once completion;
- ASR expiration -> recovery -> late callback CAS rejection;
- typed failure matrix and closed safe-copy mapping;
- concurrent reconnect signals and one create/poll/due provider action;
- WorkManager DB-commit/enqueue kill boundary and public Headless JS proof;
- iOS processing-task registration, expiration, one shared cycle, pending
  reschedule;
- cleanup delete-success/delete-failure/pointer ordering and coalesced scans;
- monotonic duration/terminal heartbeat/reload cases;
- router/reducer/navigation/refresh zero-side-effect cases;
- existing recording, route-switch, checkpoint, partial coverage, notes, source
  sync, corrections, To-dos, sharing, secure session, Memory default-off/owner
  isolation, contract import, typecheck, lint, native verifiers, and shared-file
  parity suites.

Artifact preflight requires at least 20 GiB free on
`/System/Volumes/Data`. Any cleanup remains inside authorized Maina rebuildable
paths and never touches device/app/user data, recordings, backups, credentials,
or evidence.

After explicit artifact review and data-preserving in-place install:

- pre/post schema and retained meeting/recording/transcript/outbox counts;
- Android and iOS Test 3 rejected/short/long locked calls;
- Android and iOS Test 5 offline capture, process death, locked reconnect, one
  flap, no foreground/Retry, no duplicate;
- navigation and refresh matrix;
- iOS F-001 cleanup repetitions;
- iOS F-005 release-signed memory/resource soak;
- Android F-003 scan-count evidence;
- safe offline UI/accessibility/notification copy on both platforms.

## 13. Build, install, rollback, and go/no-go boundary

After implementation approval—not in this documentation round:

1. Land the harness change separately and prove all monitors stay alive/logs
   grow.
2. Land one coherent shared/native correction and run focused/full gates.
3. Stop if the public Android Headless JS integration proof fails.
4. Check disk >=20 GiB.
5. Build exactly one Android APK and one signed iOS app/archive **without
   installing**.
6. Record commits, versions, signatures, iOS expiry, sizes, SHA-256, changed
   files, migration result, tests, exclusions, rollback, and residuals.
7. **HOLD artifacts for Admin/owner review.**
8. Install in place only after explicit approval; never uninstall/clear data.
9. Run physical qualification and submit a READY TO FREEZE handoff only if all
   blocking findings pass independently.

Rollback:

- the migration is additive; older code ignores nullable/new tables;
- cancel versioned Worker/request identifiers without deleting SQLite/audio;
- disable new wake/navigation behavior behind its rollout flag if necessary;
- rollback only by compatible signed in-place install;
- preserve recordings, transcript blocks, notes, To-dos, outboxes, secure
  session, diagnostics, and owner harness files.

GO to artifact build only after Admin approves this plan, Headless JS/native
registration proofs pass, focused/full tests pass, disk is sufficient, and no
contract/store/token duplication exists.

GO to install only after the artifact manifest/hashes/signatures/data migration
and rollback are reviewed explicitly.

GO to freeze only after F-001, F-005, F-008 through F-014 and the required
navigation/refresh cases pass on the installed candidates; F-003 scan behavior
is bounded; retained data is unchanged; and Admin's independent gate passes.

## 14. Complete F-001 through F-014 disposition

| ID | Severity | Round 3 disposition | Release condition |
| --- | --- | --- | --- |
| F-001 | P1 | **FIX INCLUDED; BLOCKING VERIFICATION** — event-driven verified iOS cleanup | Three complete-transcript shapes delete directory then pointer within 60s; duration preserved |
| F-002 | P2 | **VERIFIED-ONLY / ACCEPTED ARTIFACT** — repaint lag without native gap | Timer catches up <=2s and never changes captured duration/state truth |
| F-003 | P2 | **FIX/AUDIT INCLUDED** — coalesce retention scans | One full scan for concurrent triggers; no mounted-screen loop |
| F-004 | Historical | **DEFERRED, OWNER/REPAIR FOLLOW-UP** | Not used as current reliability evidence; no new capture may reproduce it |
| F-005 | P1 | **BLOCKING VERIFICATION** — release memory/CPU plateau gate | 60m/120-window + second-run criteria pass without termination/stall |
| F-006 | Test control | **FIX INCLUDED IN HARNESS** | Active-test launch cannot use `--terminate-existing`; monitors preflight alive |
| F-007 | Accepted ASR artifact | **ACCEPTED, DEFERRED MODEL REVIEW** | Not classified as capture loss; same difficult interval retained as fixture |
| F-008 | P0 | **FIX INCLUDED; BLOCKING PHYSICAL TEST** — iOS unattended same-meeting resume | Rejected/short/2m locked calls pass without foreground |
| F-009 | P1 | **FIX INCLUDED; BLOCKING REGRESSION** — terminal heartbeat/modal reducer | No heartbeat/recovery modal after durable terminal state, including relaunch |
| F-010 | P0 privacy | **FIX INCLUDED; BLOCKING PHYSICAL TEST** — Android typed system pause | Zero call-interval marker on telephony/WhatsApp; post-call speech present |
| F-011 | P1 | **FIX INCLUDED; BLOCKING REGRESSION** — monotonic capture metadata | 82.777s remains truthful after reload/cleanup; gap remains separate |
| F-012 | P0 | **FIX INCLUDED; BLOCKING PHYSICAL TEST** — typed autonomous notes retry | Both phones converge offline->online with no foreground/Retry/duplicate |
| F-013 | P1 | **FIX INCLUDED; BLOCKING PHYSICAL TEST** — Android source wake/UI convergence | One canonical source and visible synced state without relaunch |
| F-014 | P2 | **FIX INCLUDED; BLOCKING UI/SECURITY TEST** — closed safe-copy mapping | No exception, hostname, URL, token, or raw provider/server text anywhere |

## 15. Platform state-transition diagrams

### Android Test 3

```text
recording
  -- mode/silence signal --> system_pause_pending(generation)
  -- chunk fsync+journal --> system_paused(gap start)
  -- duplicate signals --> same generation/no-op
  -- stable normal+unsilenced --> system_resume_pending
  -- AudioRecord active --> new chunk/same meeting --> recording
  -- manual Pause --> manual_paused (never auto-resume)
  -- bounded exhaustion --> terminal_partial --> ASR/notes/source
```

### iOS Test 3

```text
recording
  -- interruption began --> chunk closed + system_paused + one watcher/assertion
  -- ended/route/CX/app signals --> probeRequested (one generation)
  -- session activation succeeds --> new chunk/same meeting --> recording
  -- UIKit time expires --> terminal/deferred partial; no false Recording
  -- terminal pipeline --> heartbeat stopped + detail replaces stale modal
```

### Android Test 5

```text
transport failure transaction
  -> typed state + enqueue_required + connectivity epoch
  -> network-constrained unique Worker (or reconciler repairs missing enqueue)
  -> public Headless JS -> one shared SQLite claim
  -> create once | poll same job once | provider retry only when due
  -> packet ready -> immutable source outbox once -> synced signal -> UI reload
```

### iOS Test 5

```text
transport failure transaction
  -> typed state + pending epoch
  -> fast path if process/continued task alive
  -> static network-constrained BGProcessing request + Expo periodic safety net
  -> OS launches when permitted -> one shared SQLite claim
  -> create/poll/due retry once -> source sync once -> committed UI signal
  -> if OS delays >30m in qualification: durable but Test 5 remains NOT READY
```

## 16. Unresolved/blocking table

| Blocker | Why it remains real | Resolution evidence required |
| --- | --- | --- |
| Android WhatsApp signal sufficiency | Current physical evidence captured user call-side speech; modes vary by VoIP/OEM | Exact Pixel telephony + WhatsApp + another VoIP marker replay |
| iOS long locked-call wake | UIKit time is finite; no Live Activity mitigation is included | Unattended two-minute locked call resumes within acceptance |
| iOS BGProcessing latency | Apple schedules opportunistically and may delay hours | Three powered/locked runs converge <=30m without foreground |
| Android Headless JS process-death bridge | Design uses public APIs but target integration is unproved | Instrumented process-death Worker->JS->completion proof |
| iOS Sherpa cancellation | Decode is synchronous; one window may finish late | Persisted generation/token test rejects late commit |
| F-001 cleanup | Canonical iOS terminal meetings retained WAVs | Three eligible terminal cleanup replays |
| F-005 resource plateau | 2.10 GB and CPU diagnostic are real endurance risks | Release-signed long soak and second-run baseline pass |
| Physical F-008–F-014 closure | Source/tests cannot substitute for device behavior | Exact installed-build screenshots/logs/DB/source fingerprints |

## 17. Primary references

- Android `isClientSilenced`:
  https://developer.android.com/reference/android/media/AudioRecordingConfiguration#isClientSilenced()
- Android mode listener and typed modes:
  https://developer.android.com/reference/android/media/AudioManager.OnModeChangedListener
- Android recording callbacks:
  https://developer.android.com/reference/android/media/AudioManager#registerAudioRecordingCallback(android.media.AudioManager.AudioRecordingCallback,android.os.Handler)
- Android WorkManager:
  https://developer.android.com/develop/background-work/background-tasks/persistent
- React Native Headless JS:
  https://reactnative.dev/docs/headless-js-android
- Apple background task registration and processing:
  https://developer.apple.com/documentation/uikit/using-background-tasks-to-update-your-app
- Apple network-constrained processing:
  https://developer.apple.com/documentation/backgroundtasks/bgprocessingtaskrequest/requiresnetworkconnectivity
- Apple scheduling-delay warning:
  https://developer.apple.com/documentation/backgroundtasks/starting-and-terminating-tasks-during-development
- Apple long-running continued processing:
  https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados/
- Expo BackgroundTask:
  https://docs.expo.dev/versions/v57.0.0/sdk/background-task/
- Expo Router:
  https://docs.expo.dev/versions/v57.0.0/sdk/router/

## 18. Round 3 issue disposition

| # | Admin issue | Disposition |
| --- | --- | --- |
| 1 | Android F-010 omitted | **ACCEPTED / ADDED** — typed native reducer, chunk/privacy rules, WhatsApp proof gate; no remote-party claim |
| 2 | iOS F-009/F-011 omitted | **ACCEPTED / ADDED** — persisted capture truth, monotonic reconciliation, terminal heartbeat/modal tests |
| 3 | iOS Test 5 wake incomplete | **ACCEPTED / ADDED** — app-specific network BGProcessing selected; 30-minute physical target; no immediate guarantee |
| 4 | F-014 raw error exposure | **ACCEPTED / ADDED** — closed safe-copy map and bounded sanitized diagnostics |
| 5 | Incomplete F-001..F-014 accounting | **ACCEPTED / ADDED** — complete table; F-001/F-005 remain blocking verification; F-003 bounded |
| 6 | Late decode after expiration | **ACCEPTED / ADDED** — persisted generation + token CAS fence and adversarial ordering test |
| 7 | WorkManager commit/enqueue crash | **ACCEPTED / ADDED** — durable scheduling truth and process/periodic reconciliation; no second outbox |
| 8 | Navigation/refresh owner wording | **ACCEPTED / ADDED** — native Back origins/fallbacks, no forward swipe, scroll-top local refresh conflict tests |
| 9 | Headless JS proof conditional | **ACCEPTED / BLOCKING** — hard pre-artifact instrumentation gate; failure returns NO-GO without internals/permissions |

## 19. Artifact-review declaration

**Current truthful state:** no Android or iOS release artifact was built,
installed, or changed during Round 3.

**Required declaration at the future artifact boundary:** “The Android APK and
signed iOS app/archive are built, hash/signature verified, not installed, and
held for explicit Admin/owner review. Installed app data remains untouched.”

That declaration may be made only after the pre-artifact blockers and tests in
this document actually pass.
