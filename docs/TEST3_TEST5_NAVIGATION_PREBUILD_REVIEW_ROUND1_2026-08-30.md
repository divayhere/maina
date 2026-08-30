# Test 3, Test 5, navigation and refresh — pre-build review round 1

Date: 2026-08-30  
Decision: **NO-GO for product edits/build until Maina Admin approves this plan**  
Scope: one data-preserving Android/iOS reliability increment; no Backend/Web change

## 1. Candidate and evidence boundary

- Android implementation: `8bb0a1c`; installed `0.10.34 (60)` on Pixel 9 Pro
  `47011FDAP000VE`.
- iOS implementation: `ff43a64`; installed `0.10.34 (16)` on iPhone 15
  `00008120-001E146611E2601E`, iOS `26.6.1`.
- iOS source review head: `fa79ea0` before this documentation-only review.
- Backend contract pin: `57cbb52`; Backend/Web are frozen and unchanged.
- Test 3 evidence: `.artifacts/m0-replay/20260830-080510-test3-call-interruption`.
- Test 5 evidence: `.artifacts/m0-replay/20260830-085309-test5-offline-recovery`.
- Test 3 iOS meeting/fingerprint: `mtf74exh-7ezcgd` /
  `8a360d3f3b9e39f542507f66d6b92d3dad28aad02da1a2a398973becdd4ce530`.
- Test 3 Android meeting/fingerprint: `mtf74drr-7z7mvm` /
  `02db162797c99de45aa61b7bf5ff94bee6b44f73efc15e0df6a809015c88a0dc`.
- Test 5 iOS meeting/fingerprint: `mtf8v88s-9nan7q` /
  `deaed32ad971818a6f5205c009479f9d19b48d226f84039bd725e35b0807c980`.
- Test 5 Android meeting/fingerprint: `mtf8v9qj-6by157` /
  `645c07df34babc94e7776df1fa6ddece8f33cfdedc2d67634e4fe8b0b37ae4f7`.
- Preserved owner files: `ios-tests/MainaUITests.swift` and
  `scripts/stop-dual-device-soak.sh`.
- No uninstall, clear-data, DB reset, recording deletion, product-code edit,
  native build, install, Backend/Web change, or full iPhone container copy was
  performed during this review.

## 2. Evidence corrections and hard constraints

### Test 3

- iOS answered and rejected calls both left capture paused while locked.
  Foregrounding Maina was the first effective recovery wake.
- The final iOS meeting retained 2:00 audio across 6:27 elapsed. The 4:27 gap
  is real omitted capture, not a timer-only defect.
- Android retained 5:51 audio across 6:18 elapsed and post-call speech, but the
  exact answered/rejected pair was not fully evidenced. Android Test 3 remains
  open.

### Test 5

- Android completed 14/14 local Qwen windows while locked but did not visibly
  converge cloud notes/sync until foreground.
- iOS stopped at 4/14 while locked and resumed from checkpoint 4 after
  foregrounding, then reached 14/14, notes ready, and source HTTP 201.
- The Android locked-state DB fields were not captured. The run does not prove
  whether `cloud_notes_job_id` existed, what `summary_status`, retry count, or
  `next_retry_at` was, what the backend job status was, or whether the first
  foreground operation created, polled, retried, or only ingested a source.
  Those values are replay requirements, not findings.
- Client-visible duplicate creation was not observed. Backend canonical
  uniqueness was not independently proved in this run.

### Toolchain correction

The machine has Xcode 26.6 and iOS SDK 26.5. Apple's
`BGTaskScheduler.submitTaskRequest(_:completionHandler:)` is iOS/iPadOS 27+ and
cannot be compiled or executed by the current release toolchain. This build
must therefore use the synchronous `submit(_:)` path on iOS 26, which already
returns immediate submission errors. An iOS 27 availability branch can be
added only after Xcode 27 is installed and qualified. Runtime selector tricks
are rejected.

## 3. Consolidated scope and estimates

| Item | Decision | Evidence / dependency | Engineering effort |
| --- | --- | --- | --- |
| Durable harness monitors | REQUIRED FOR THIS BUILD | Current child loggers died silently | Small |
| iOS continued-task identity/ownership | REQUIRED FOR THIS BUILD | Wildcard registered at runtime; Qwen promise detached | Large |
| iOS call-recovery watcher | REQUIRED FOR THIS BUILD | Physical Test 3 failed twice | Medium |
| iOS Live Activity resume action | DEFERRED | Not needed to fix ownership; cannot prove unattended resume | Separate product increment |
| Android durable reconnect classification | REQUIRED FOR THIS BUILD | Current schema cannot distinguish transport from server backoff | Medium |
| Android process-death network wake | REQUIRED FOR THIS BUILD | Periodic 15-minute worker is inexact; process-alive listener is insufficient | Medium |
| Home/detail terminal convergence | REQUIRED FOR THIS BUILD | Home lacks the persisted pipeline signal subscription | Small |
| Outer-stack navigation correction | REQUIRED FOR THIS BUILD | Hidden meeting tab retains stale stack | Medium |
| Home/To-dos/meeting/Notifications refresh | REQUIRED FOR THIS BUILD | Home/To-dos exist; other reads need local-only refresh | Small |
| Android predictive animation | DEFERRED | SDK 57 requires alpha ExperimentalStack; current stack/modal/header mix cannot safely adopt it | Separate qualification |
| iOS 27 async submit API | DEFERRED | Xcode 26.6 / SDK 26.5 cannot compile it | Xcode 27 phase |
| Backend/Web contract work | NOT REQUIRED | Existing idempotent contracts are sufficient | None |

Estimates are sizing only, not deadlines or acceptance evidence.

## 4. REQUIRED — iOS continued-processing lifecycle

### 4.1 Exact identifier and registration

Use one deterministic identifier per meeting job:

`<bundle-id>.continued-processing.transcription.<sha256(meeting-id)[0...23]>`

The meeting ID is never placed in the identifier or logs. A retry of the same
meeting uses the same identifier; two meetings receive different identifiers.

Native state:

- `registeredIdentifiers: Set<String>` prevents a second registration in one
  process. Re-registering an identifier is fatal according to Apple.
- `contextsByIdentifier: [String: Context]` owns task, progress, expiration,
  completion and meeting-hash state.
- A small local `UserDefaults` pending registry stores only exact identifier,
  meeting ID and task state. It contains no transcript or credential.
- AppDelegate reads pending identifiers and registers every exact handler
  before React Native initialization. The wildcard remains only in
  `BGTaskSchedulerPermittedIdentifiers`.

Repeat and lifecycle rules:

1. `begin` for an already-running meeting returns the existing context and
   completion handle; it never registers/submits again.
2. A retry after task completion reuses the already registered handler in the
   same process and submits the same deterministic meeting job again.
3. Cancellation cancels the pending request, marks checkpoint cancellation,
   completes an attached task once, and removes the persisted pending context.
4. Relaunch re-registers persisted exact IDs before React Native and lets the
   durable checkpoint reconciliation attach to the pending native task.
5. Qwen remains globally serialized. If meeting B arrives while meeting A owns
   Qwen, B is durable-queued. It does not cancel A or run a second model.

### 4.2 Submission path

- Start or resume the Qwen engine immediately from the user stop/save action.
- Register the exact handler once, then submit `.fail` so an unavailable
  continued-processing slot is explicit rather than silently queued.
- On iOS 26 use `try BGTaskScheduler.shared.submit(request)` and persist the
  sanitized synchronous result.
- After an Xcode 27 upgrade, use
  `submitTaskRequest(_:completionHandler:)` behind `#available(iOS 27, *)`, and
  keep the iOS 26 fallback until the minimum OS changes.
- Do not cancel an unrelated active meeting request.
- Submission failure does not create another engine. Foreground execution may
  continue; if the app backgrounds, a short UIKit assertion is used only to
  reach the next durable window checkpoint and defer.

### 4.3 One execution owner and completion handle

Replace the detached Boolean launch contract with:

```text
IOSPostProcessingHandle {
  meetingId
  started
  completion: Promise<IOSPostProcessingOutcome>
  requestCheckpointStop(reason)
}
```

- Foreground save obtains the handle and does not await `completion`, so UI is
  responsive.
- A generic Expo/OS background callback obtains the same handle and awaits its
  `completion` before returning `Success` or `Failed`.
- If no work exists, the OS callback starts exactly one durable run and awaits
  it. If work exists, it awaits that same promise.
- BGContinuedProcessingTask is an OS monitor/assertion attached to the same
  engine. It is not another worker.
- Generic BGProcessing is a later resume owner only. It does not submit a new
  continued task because it was not initiated by a current user action.

State machine:

```text
durable queued
  -> engine running
  -> continued request submitted (foreground-start only)
  -> monitor attached OR submission unavailable
  -> each Qwen window transactionally checkpointed
  -> normal complete -> packet/sync handoff -> complete(success)
  -> expiration requested -> finish current window -> checkpointed/deferred
     -> complete(false) -> later generic worker/foreground resumes
  -> late OS attach -> bind to existing engine, or start from checkpoint after RN ready
```

Exactly-once completion is enforced by a native `CompletionGate` with states
`open -> expirationRequested|normalRequested -> completed`. The expiration
handler only sets `expirationRequested` and requests stop-after-checkpoint. It
does not call `setTaskCompleted` directly. The engine checks the flag after the
current SQLite window transaction commits, returns `deferred`, and one native
`completeIfNeeded(success:false)` call closes the task. Normal completion uses
the same gate. Repeated expiration/finally/cancel calls are no-ops after close.

## 5. REQUIRED — iOS Test 3 recovery watcher

### 5.1 Ownership and coalescing

At interruption begin:

1. Close/finalize the active WAV.
2. Increment the chunk index once.
3. Set native state `paused/interrupted`.
4. Create one `RecoveryWatcher` for the current generation and one UIKit
   background assertion immediately.

Interruption-ended, route changes, iOS resumption recommendations,
`CXCallObserver`, and app-active are only signals into that watcher. They do not
increment the generation, reset backoff, or spawn loops. A signal sets
`probeRequested`; if no probe is running, the watcher tries session activation.

The watcher probes at most every 1 second while
`UIApplication.shared.backgroundTimeRemaining > 3` seconds. It does not consume
a fixed 30-second retry budget while the call still owns the microphone. A
failed activation remains paused and waits for the next signal/tick. Background
expiration stops the watcher and leaves a truthful safe-paused checkpoint.

Deliberate Pause, Stop, Abort, meeting replacement, and successful resume each
increment/cancel the generation, cancel timers, and end the background task.
Stale callbacks fail the generation check.

### 5.2 Audio safety

- Maina keeps `.record`/`.measurement`; it never mixes or captures remote call
  audio.
- No WAV opens while the call owns the session.
- Resume first succeeds at `setActive(true)`, then prepares/starts a brand-new
  monotonic chunk in the same meeting, then changes native state to Recording.
- Existing closed chunks are never reopened or overwritten.

### 5.3 Physical acceptance durations

- Rejected call: ring for 5-15 seconds; require unattended resume within 5
  seconds of rejection and no more than 3 seconds post-call loss.
- Short answered call: talk for 15-25 seconds; require unattended resume within
  5 seconds while the UIKit assertion survives.
- Long answered call: talk for 2 minutes. Require pre-call audio safety, no call
  audio, truthful paused state, same meeting identity, and immediate recovery
  on the first public OS wake. Public iOS APIs do not guarantee that a suspended
  process wakes at call end, so zero-touch long-call resume is a documented
  platform residual, not a claim this build can make.

### 5.4 Live Activity

Live Activity / `AudioRecordingIntent` is **DEFERRED**. No source proof currently
shows that an intent can reattach to the existing native meeting before React
Native initializes, and adding an extension, entitlements and lock-screen
authentication increases installed-data/release scope. It must not be used to
claim unattended Test 3 passed. A later owner-approved mitigation can provide a
one-tap lock-screen resume after proving same-meeting attachment.

## 6. REQUIRED — Android Test 5 retry and process ownership

### 6.1 Smallest durable state addition

Append schema v16; never edit a shipped migration:

`cloud_notes_failure_class TEXT`

Allowed values: `transport`, `server_backoff`, `auth`, `protocol`, or null.
The operation is derived, not duplicated:

- no `cloud_notes_job_id` -> create;
- job ID + ordinary queued/running state -> poll existing;
- backend reports `failed_retryable` and retry is due -> provider retry.

Classification rules:

- offline, timeout and status 0 -> `transport`;
- HTTP 429/5xx or backend `failed_retryable` -> `server_backoff`;
- 401/403 -> `auth`;
- invalid response/schema -> `protocol`;
- clear on successful create/poll/ready.

Connectivity restoration may bypass a future local retry time exactly once for
`transport`. It may create a never-created job or poll an existing job. It may
not POST provider retry while server backoff is not due, and may never include
auth, protocol, incomplete-ASR or terminal work. User-facing strings are never
parsed to determine this class.

### 6.2 Persistent network wake

Expo BackgroundTask already uses one network-constrained WorkManager worker,
but imposes a 15-minute minimum and OS-controlled delay. The in-process NetInfo
listener cannot recover a dead React Native runtime.

Add one Android native unique request:

- name: `maina-pipeline-connectivity-wake-v1`;
- `OneTimeWorkRequest`;
- constraint `NetworkType.CONNECTED`;
- policy `KEEP` so repeated offline/foreground signals coalesce while the same
  request is unfinished;
- no exact alarm, polling, second outbox, packet serialization, endpoint or
  token logic.

The request invokes Expo's existing pinned `BackgroundTaskWork`, which starts
the registered TaskManager callback and awaits the shared TypeScript
`runPipelineRecoveryCycle`. It is scheduled when a durable transport failure
is stored and when native ASR finishes while connectivity is unavailable.
SharedPreferences carries only a one-shot sanitized wake reason. The callback
consumes that reason and calls the same TypeScript drain.

This uses the pinned `expo-background-task` Android worker rather than copying
the mobile cloud contract. A native compile/verifier test must fail if that
pinned class or app-scope input changes during a dependency upgrade.

The existing 15-minute Expo worker remains an eventual safety net. The new
one-time request owns connectivity recovery after process death; the NetInfo
listener is only the faster process-alive signal.

### 6.3 Concurrency and duplicate proof

Tests fire NetInfo reconnect, foreground, one-time WorkManager and periodic OS
signals concurrently. Acceptance requires:

- one effective `runPipelineRecoveryCycle` in-process;
- one stable backend job hash if a job already exists;
- one stable packet hash and immutable source-key fingerprint;
- no provider retry before server due time;
- one canonical source response, with idempotent retries allowed;
- retry count increments only for a real failed attempt.

Sanitized diagnostics must record signal, derived operation, failure class,
retry due/not-due, hashed job/source identity, and WorkInfo state. They must not
record transcript, token, URL, provider credential, or payload.

## 7. REQUIRED — UI convergence and refresh

### Persisted state subscription

`mainaKnowledgeCloud.ts` already emits a meeting pipeline signal after every
persisted source-sync transition, and meeting detail subscribes. Home does not.
Home must subscribe to `subscribeMeetingPipelineChanges` and reload canonical
SQLite through `useMeetings.refresh`. To-dos subscribes when the changed meeting
can affect its rows. Event payloads remain hints; SQLite remains truth.

No new polling loop is added. The existing detail pending timer may remain only
while state is genuinely nonterminal.

### Pull-to-refresh policy

- Home: keep existing local SQLite refresh; add an accessible label and test
  spinner completion on success/failure.
- To-dos: keep existing local SQLite/todo refresh; same accessibility/error
  test.
- Meeting detail: add local-only pull refresh for meeting, transcript blocks,
  to-dos and corrections. Do **not** call the existing `load()` path that can
  auto-queue notes; split `reloadLocalState()` from `maybeAdvancePipeline()`.
- Notifications: add local-only refresh of the meetings store. It must not run
  notification actions.
- Memory: DEFER until its default-off surface is activated. Then refresh may
  reload owner-isolated cache and one serialized idempotent read request only.
- Settings, Help, Diagnostics, active Recording and recovery/destructive forms:
  no pull-to-refresh. Diagnostics retains its explicit refresh button.

A refresh never retries, creates/polls a cloud job, resets backoff, starts
Qwen, syncs a source, or becomes a network loop.

## 8. REQUIRED — navigation architecture

### Exact current Android failure path

1. Home calls `router.push('/meeting/A')`.
2. Because `meeting` is a hidden route inside `(tabs)`, meeting A remains in
   that nested tab stack.
3. The global mic calls root `router.push('/record')`.
4. Save calls `router.replace('/meeting/B')`. It replaces the modal/current
   route but does not reset the hidden meeting stack containing A.
5. Android Back pops B and reveals A.

The same structure also allows drawer `router.push` calls to accumulate
duplicate hidden destinations. This is source-proven, not inferred.

### Structure

Follow Expo Router's documented pattern: keep only Home and To-dos inside the
tab navigator; move meeting detail/recovery and auxiliary screens to the outer
native Stack. Add a root initial anchor `(tabs)` so a deep-linked meeting has
Home beneath it. Do not add a pan responder or forward-swipe gesture.

Keep the current global bottom bar visually available through a pathname-aware
root shell, but remove its dependence on hidden tab route state. Home/To-dos
selection performs an explicit root reset; the center mic opens the record
modal. Native iOS interactive pop, Android system Back and the header button all
operate on the same outer stack.

Standard Expo Router Stack remains in this build. Android's system Back gesture
and button are required to work. Predictive-back animation is deferred because
SDK 57 documents it only for the alpha ExperimentalStack, which cannot mix with
the current Stack and lacks the modal/custom-header options Maina uses.

### Screen-level matrix

| Screen | Permitted entry | Back destination / fallback | Bottom bar | Mutation |
| --- | --- | --- | --- | --- |
| Home | launch, Home tab, drawer, fallback | none; OS exits/backgrounds app | visible, Home selected | root reset/navigate |
| To-dos | tab, drawer, meeting “Open all” | tab root; fallback Home | visible, To-dos selected | root reset/navigate |
| Meeting detail | Home card, To-do, notification, saved recording, recovery, deep link | exact origin; deep-link fallback Home | visible, neither tab falsely selected | outer-stack push; save uses reset below |
| Interrupted recovery | interrupted card, detail redirect, deep link | exact origin; fallback Home | visible | push/redirect replace |
| Recording | center mic, hardware trigger, automation | Cancel returns true origin; fallback Home | hidden in modal | push modal; cancel dismiss |
| Notifications | bell | prior meaningful screen; fallback Home | visible | singleton navigate/push |
| Memory | drawer only while flag enabled | prior meaningful screen; fallback Home | visible | singleton navigate |
| Settings | drawer | prior meaningful screen; fallback Home | visible | singleton navigate |
| Help | Settings or drawer | Settings/true origin; fallback Home | visible | push/singleton navigate |
| Diagnostics | Settings | Settings; fallback Home | visible | push |
| Deep-linked meeting/recovery | verified app/deep link | anchored Home | visible | root anchor + push |

Special terminal rules:

- Recording save dispatches one root `CommonActions.reset` with `(tabs)` Home
  at index 0 and meeting B at index 1. Back from B is Home, never meeting A.
- Recording cancel dismisses to the true origin if valid; otherwise Home.
- Recovery Keep/Open/Re-transcribe replaces recovery with the saved detail; it
  never pushes detail above stale recovery.
- Delete resets to Home after the transaction commits; no route to the deleted
  ID remains.
- Home/To-dos selection clears auxiliary screens and returns the selected tab
  to root.
- Drawer uses singleton `navigate`, never unconditional `push`; selecting the
  current destination is a no-op.
- `TopBar` uses `router.canGoBack()` then `back`, otherwise `replace('/')`.
  Deep-link anchoring makes native gesture/system Back match this fallback.

## 9. File-level change map

### Test-only commit first

- `scripts/m0-replay-harness.sh`: supervisor-owned monitor process groups,
  exact device identity, PID/cmdline and log-growth preflight, fail-fast
  snapshots, bounded stop.
- `scripts/stop-dual-device-soak.sh`: preserve owner changes; integrate only
  after diff review.
- harness tests: dead logger, wrong iPhone, wrong Pixel, zero log growth.

### Shared TypeScript/navigation commit, mirrored byte-for-byte

- `src/data/db.ts`: append v16 failure-class migration.
- `src/data/meetings.ts`: field mapping and reason-aware selectors.
- `src/services/cloudRetryPolicy.ts`: classify transport versus server backoff.
- `src/services/meetingPacket.ts`: explicit recovery reason and operation
  diagnostics; no contract change.
- `src/services/backgroundPipeline.ts`: OS callback awaits iOS completion and
  consumes durable wake reason.
- `src/services/meetingCaptureLifecycle.ts`: completion-handle ownership;
  global serialized iOS Qwen queue.
- `src/app/_layout.tsx`: reasoned foreground/connectivity wake and outer stack.
- `app.json`: keep Android predictive Back disabled for the standard stack;
  retain the continued-processing wildcard only in iOS permitted identifiers.
- `src/services/meetingPipelineSignals.ts`: retain hint-only semantics.
- `src/app/(tabs)/index.tsx`, `todos.tsx`: subscriptions and verified refresh.
- move meeting/recovery/notifications/settings/help/diagnostics/memory routes
  from hidden tabs to root stack; update imports only, preserve screen content.
- `src/design/shell.tsx`: safe Back, singleton drawer, root-aware bottom bar and
  tab resets.
- new `src/services/navigationPolicy.ts`: pure reset/fallback decisions.
- meeting/notifications screens: local-only refresh split.

### iOS native commit

- `modules/maina-recorder/ios/MainaIOSContinuedProcessing.swift`: exact-ID
  registry, contexts, completion gate, iOS 26 submission, checkpoint stop.
- `modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift`: coalesced
  recovery watcher and call/resumption signals.
- `modules/maina-recorder/ios/MainaRecorderModule.swift`: completion/wake bridge.
- `modules/maina-recorder/src/index.ts` and
  `src/hardware/recording/foreground.ts`: typed bridge only.
- `plugins/withMainaIOSContinuedProcessing.js` / AppDelegate generation:
  persisted exact-ID launch registration; wildcard stays in Info.plist.

### Android native commit

- `modules/maina-recorder/android/build.gradle`: pinned compile dependency on
  Expo background worker.
- new `MainaPipelineConnectivityWake.kt`: unique connected WorkManager request,
  one-shot wake reason, status diagnostics.
- `MainaRecorderModule.kt` and module TypeScript bridge: schedule/consume/status.
- `MainaPostProcessingService.kt`: schedule wake after durable ASR completion
  where required; no cloud fields or endpoints in native code.

## 10. Automated test matrix before any build

### iOS native/ownership

- deterministic distinct identifiers for two meetings;
- same meeting registers once and repeated begin reuses context;
- relaunch restores pending exact handlers; duplicate registration rejected by
  ledger;
- cancellation and completion remove pending context;
- foreground launch is nonblocking; OS worker awaits same promise;
- attach, late attach, submission refusal, expiration and normal completion;
- `setTaskCompleted` exactly once under expiration/finally/cancel races;
- expiration stops only after durable window checkpoint;
- two meetings never run Qwen concurrently.

### Test 3 native capture

- simultaneous route/interruption/resumption/call signals create one watcher;
- long call does not exhaust/reset fixed retries;
- deliberate Pause/Stop cancels every watcher/background task;
- session activation precedes new monotonic WAV creation;
- call interval contains no captured audio; post-call marker is present.

### Android/shared Test 5

- create when no job ID; immediate poll when transport failed with job ID;
- 429/5xx/provider failure preserves future server backoff;
- auth/protocol/incomplete ASR excluded;
- simultaneous reconnect/foreground/one-time/periodic signals produce one
  effective job/source and stable hashes;
- WorkManager request survives process death and runs only when connected;
- repeated scheduling coalesces; completed request may be scheduled again;
- network flap preserves retry accounting.

### UI/navigation/refresh

1. Home -> meeting A -> Back = Home.
2. To-dos -> source meeting -> Back = To-dos.
3. Notification -> meeting -> Back = Notifications.
4. meeting A -> Record -> save -> meeting B -> Back = Home.
5. recovery -> saved detail -> Back has no stale recovery.
6. delete -> Home; gesture/system Back cannot reopen deleted route.
7. deep-link meeting -> Back = Home.
8. repeated drawer destinations do not grow history.
9. iOS interactive pop, header Back, and Android system Back match.
10. pull refresh reloads persisted terminal state with zero packet/source/Qwen
    side effects.
11. Home/detail/To-dos update from a persisted terminal signal without relaunch.
12. refresh indicator clears on success and injected failure; accessibility
    label/state is present.

Run existing recording, ASR partial coverage, packet, sync, corrections,
To-dos, sharing, retention, Memory cache isolation and feature-flag suites.
Memory A/B/C flags remain default-off.

## 11. One-build install and physical replay

1. Admin approves this pre-build manifest.
2. Fix and independently verify the harness in a test-only commit.
3. Implement one coherent shared/native increment; mirror shared files and run
   parity/diff gates.
4. Run focused suites, complete tests, typecheck, lint, native verifiers,
   contract import, coordination and release gates.
5. Build Android and iOS once after all gates pass.
6. Install in place with retained-data counts before/after. Never uninstall or
   clear data. Record exact versions, commits and iOS signing expiry.
7. Replay Test 3 rejected, short answered and long answered cases with no
   foregrounding during required unattended windows.
8. Replay Test 5 offline stop, lock, reconnect, one flap, process-death wake,
   and no Retry/foreground tricks. Capture the previously missing locked DB
   fields and operation diagnostics.
9. Verify one canonical backend source and no duplicate/mutation conflict.
10. Admin runs independent final freeze qualification.

## 12. Rollback, residual risks and go/no-go

Rollback:

- New behavior is gated by source commit and one app version; rollback is an
  in-place install of the last signed candidate only if its database schema is
  forward-compatible.
- Schema v16 is nullable/additive, so old code ignores it.
- WorkManager tasks use versioned unique names and can be cancelled without
  touching recordings or SQLite.
- Route changes do not alter meeting IDs or data; feature flags remain off.
- Preserve all installed recordings, SQLite rows, Keychain/Keystore session,
  diagnostics and native outboxes.

Residual risks:

- iOS can expire/terminate continued processing under resource pressure;
  checkpoints guarantee safety, not continuous CPU time.
- User force-swipe cancels Apple's running background tasks.
- Arbitrarily long answered calls can suspend Maina with no public automatic
  wake at call end. This build cannot honestly promise zero-touch long-call
  resume.
- The Android one-time wake relies on the pinned Expo BackgroundTask worker;
  dependency upgrades require a compile/behavior verifier.
- Predictive-back animation remains deferred; functional Android system Back
  remains required.

GO to build only if:

- Admin accepts the long-call platform limitation and this bounded scope;
- all automated gates pass on both branches with shared-file parity;
- no duplicate registration/completion/retry owner exists in diff review;
- harness monitor preflight passes;
- no Backend/Web contract change is introduced.

GO to freeze only if physical Tests 3 and 5 pass their stated acceptance,
retained-data counts match, one canonical source is independently verified,
navigation tests pass on both devices, and Admin independently qualifies the
installed builds.

NO-GO if iOS rejected/short calls still require foreground, if either device
needs a Retry/foreground trick for Test 5, if UI remains stale after persisted
terminal state, if Back exposes meeting A/deleted/recovery state, or if any
duplicate job/source/registration/completion is observed.

## 13. Authoritative references

- Apple, Performing long-running tasks on iOS and iPadOS:
  https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados
- Apple, `BGTaskScheduler.register` lifecycle and duplicate-registration rule:
  https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/register(fortaskwithidentifier:using:launchhandler:)
- Apple, iOS 27 asynchronous task submission:
  https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/submittaskrequest(_:completionhandler:)
- Apple, audio interruption delivery and suspended-process caveat:
  https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification
- Android, unique persistent WorkManager work:
  https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work
- Android, WorkManager API and `KEEP` semantics:
  https://developer.android.com/reference/androidx/work/WorkManager.html
- Expo BackgroundTask (single worker, network constraint in pinned source,
  inexact minimum interval):
  `node_modules/expo-background-task/android/src/main/java/expo/modules/backgroundtask/BackgroundTaskScheduler.kt`
- Expo Router outer-stack detail pattern:
  https://docs.expo.dev/router/basics/common-navigation-patterns/
- Expo Router stack reset/dismiss APIs:
  https://docs.expo.dev/router/advanced/stack/
- Expo SDK 57 ExperimentalStack predictive-back limits:
  https://docs.expo.dev/versions/v57.0.0/sdk/router/experimental-stack/
