# Test 3, Test 5, navigation and refresh — pre-build review round 2

> Superseded by
> `docs/TEST3_TEST5_NAVIGATION_PREBUILD_REVIEW_ROUND3_2026-08-30.md`, which
> reconciles the complete canonical F-001 through F-014 physical ledger. This
> file is retained as historical review evidence.

Date: 2026-08-30

Decision: **NO-GO for product code, build, install, or owner approval**

Allowed action in this round: documentation correction only

Scope after approval: one data-preserving Android/iOS reliability increment;
no Backend/Web contract or implementation change

## 1. Authoritative boundary and corrected pins

The accepted frozen inputs are:

- Backend source: `6b2bcf43c2e8c4fb7c40a6cb6fb49e643099f93b`.
- Backend deployed runtime: `d6d67e1`.
- Web source: `5b11bb026ff5fff36c7b393add9c0c64986a1335`.
- Web deployed runtime: `ec44286`.
- `57cbb52fdefe902f985ed9eaca57c6be5cb7ee5f` is an earlier Release A
  publication correction titled `fix: publish concrete frozen recall
  contracts`. It is historical evidence, **not** the accepted Apps freeze pin.
- Android installed candidate: `0.10.34 (60)`; implementation source
  `8bb0a1c`; branch review head before this document `183527f`.
- iOS installed candidate: `0.10.34 (16)`; implementation source `ff43a64`;
  branch review head before this document `90b44fd`.
- Both mobile branches currently point their coordination submodule at
  `831a957`; it advances only in a later approved mobile change.
- Memory A/B/C flags remain default-off.
- Owner files `ios-tests/MainaUITests.swift` and
  `scripts/stop-dual-device-soak.sh` remain outside this review diff.

This correction adds or changes no endpoint, request/response field, source
key, packet schema, provider, prompt, credential, session, retrieval algorithm,
datastore, or Backend/Web deployment. Both apps continue to consume the frozen
backend contract at `6b2bcf43...`.

## 2. Direct source evidence

| Finding | Source | Required response |
| --- | --- | --- |
| iOS reuses a meeting-derived request ID | `MainaIOSContinuedProcessing.swift:51-59` | Fresh ID for every submission; never resubmit a terminal ID |
| iOS registers a wildcard at runtime | `MainaIOSContinuedProcessing.swift:113-120` | Register each exact submitted ID; wildcard remains only in Info.plist |
| One active task has competing completion paths | task at line 18; finish at 99-109; expiration at 127-130 | Per-submission contexts and one completion gate |
| JavaScript detaches Qwen | `meetingCaptureLifecycle.ts:195-201` | Return a completion handle; OS worker awaits it |
| Qwen decode is synchronous/no abort hook | `MainaQwenAsr.swift:121` | Last committed window is truth; in-flight window may replay |
| Window commit follows inference | `localAsrPipeline.ts:175-220` | Expiration cannot promise a new checkpoint |
| iOS recovery begins after interruption end | `MainaIOSNativeAudioCapture.swift:541-565` | Begin one watcher/assertion at interruption begin |
| Retry chain is about 30 seconds | `MainaIOSNativeAudioCapture.swift:57-60,596-650` | Do not exhaust retries while a call owns audio |
| Expo task is one inexact worker | `backgroundPipeline.ts:47-81`; Expo minimum 15 minutes | Safety net, not immediate process-death recovery |
| Expo Android worker uses implementation-specific routing | `BackgroundTaskWork.kt` requires `appScopeKey` and shared scheduler | Never invoke it directly |
| Cloud errors collapse to status/`network_error` | `mainaCloudSession.ts:133-168`; `cloudRetryPolicy.ts:20-31` | Persist machine failure kind and operation |
| Create/poll/provider retry are distinct | `meetingPacket.ts:252-320` | Reconnect creates/polls once; provider retry stays due-gated |
| Meeting/recovery are hidden tabs | `(tabs)/_layout.tsx:26-31` | Move only these detail routes to outer Stack |
| Record save replaces the modal | `record.tsx:857,882,1077` | Atomic reset to fresh Home + new detail |
| Drawer always pushes | `design/shell.tsx:88,136` | Singleton navigation |
| Home/To-dos already refresh | `(tabs)/index.tsx:128`; `(tabs)/todos.tsx:192` | Constrain/verify; do not duplicate |
| Detail already subscribes to persisted signals | `meeting/[id].tsx:390` | Apply hint-to-SQLite reload only where missing |

The installed iOS 26.5 SDK exposes synchronous
`BGTaskScheduler.submitTaskRequest(_:error:)`, not the iOS 27 completion-handler
API. This build records immediate submission errors. The iOS 27 path is
deferred until Xcode 27 is installed; reflection is rejected.

## 3. Scope disposition

| Proposal | Decision |
| --- | --- |
| Harness monitor survival/evidence preflight | **REQUIRED FOR THIS BUILD** |
| Unique iOS submissions and one completion owner | **REQUIRED FOR THIS BUILD** |
| Bounded iOS call-recovery watcher | **REQUIRED FOR THIS BUILD** |
| Android typed retry state and process-death wake | **REQUIRED FOR THIS BUILD** |
| Persisted UI convergence and local-only refresh | **REQUIRED FOR THIS BUILD** |
| Outer meeting/recovery routes and record-save reset | **REQUIRED FOR THIS BUILD** |
| Live Activity / AudioRecordingIntent | **DEFERRED** |
| iOS 27 async submission | **DEFERRED** |
| Android predictive animation | **DEFERRED**; destination correctness required |
| Per-tab stack redesign / moving every auxiliary route | **REJECTED FOR THIS BUILD** |
| Backend/Web work | **EXCLUDED** |
| Relax long-call acceptance | **CONDITIONAL OWNER DECISION**; otherwise physical failure blocks promotion |

## 4. iOS continued-processing lifecycle

### 4.1 Unique identity, exact registration, no reuse

Every foreground user-started submission gets:

```text
com.divay.maina.staging.continued-processing.transcription.
<sha256(meetingId)[0..15]>.<monotonicRunSequence>-<uuid[0..15]>
```

An app-private native registry maps:

```text
submissionId -> meetingId, runSequence, lifecycle, createdAt, updatedAt
```

It stores no transcript, audio, token, URL, provider key, or customer text.
UUID prevents reuse even if a sequence is restored incorrectly; sequence makes
ordering diagnosable. Lifecycle is:

```text
allocated -> registered -> submitted -> delivered -> claimed
          -> completed | deferred | cancelled
```

Foreground Stop/Save or explicit Re-transcribe ordering:

1. Commit durable ASR-queued state.
2. Start/obtain the single JS/Qwen execution handle immediately.
3. Allocate and persist a fresh ID on the native serial queue.
4. Register that exact ID once and add it to the process ledger.
5. Submit `.fail` with the exact ID.
6. Persist the synchronous submit outcome. Refusal changes only monitoring; it
   never starts another engine or loses durable work.

Repeated `begin` for the same active run returns its existing handle/ID. A later
retry gets a new sequence and UUID. A terminal ID is never submitted again.

### 4.2 Concurrency, relaunch, and bounds

Qwen remains globally serialized. Only work that starts immediately from the
foreground action gets a continued assertion. Meeting B queued behind A is
durable but does not create a speculative assertion; it resumes through
foreground/generic recovery unless the user later starts it explicitly.

- Keep exact IDs in `registeredIdentifiers` for process lifetime because a
  second registration is fatal.
- Bound persisted nonterminal records to 8. Remove terminal records from
  pending immediately; retain at most 64 sanitized tombstones for seven days.
- Cap in-process exact registrations at 64. At the cap, disable new assertions
  until relaunch while durable recovery continues.
- At launch, register each persisted nonterminal exact ID before RN. Reconcile
  scheduler pending requests. Orphans older than 24 hours become deferred or
  cancelled, never resubmitted.
- Late delivery for terminal work is claimed, checked against SQLite, and
  completed once without rerunning Qwen.

### 4.3 One execution owner

Replace the detached Boolean with:

```text
IOSPostProcessingHandle {
  meetingId, runId, started,
  completion: Promise<completed | deferred | failed>,
  requestDeferred(reason)
}
```

- Foreground UI launches without awaiting completion.
- Expo TaskManager/BGProcessing obtains the same handle (or starts one durable
  run) and awaits completion before returning its OS result.
- `BGContinuedProcessingTask` monitors the same engine; it is not a worker.
- Generic recovery may resume checkpoints but never submit a new continued
  assertion from background.

```text
durable queued -> engine running
  -> foreground monitor submitted or unavailable
  -> OS delivered -> RN claims same engine
  -> committed window -> next window
  -> normal terminal -> complete(success)
  -> expiration -> request stop -> complete(false) promptly
       -> uncommitted window replayable -> later durable recovery
```

### 4.4 Expiration truth and exactly-once completion

Sherpa cannot be cancelled mid-window. The expiration handler therefore does
not wait for or promise a fresh checkpoint:

1. Atomically move `CompletionGate` from `open` to `expiring`.
2. Emit expiration to JS and start a 1-second native fail-safe.
3. JS marks the handle deferred and requests stop after current decode returns.
4. If JS acknowledges, complete false immediately. Otherwise the fail-safe
   calls `setTaskCompleted(false)` exactly once and releases the OS handle.
5. The last committed SQLite window remains truth. If decode later returns it
   may commit once and stop; if suspended/killed, the absent window replays.
   Duplicate computation is possible; duplicate transcript rows are not.

Normal completion, expiration, cancellation, bridge timeout, and `finally`
share one `completeIfOpen`; later calls are no-ops. UIKit fallback expiration
ends synchronously under the same last-committed-window rule.

### 4.5 RN-not-ready / late attach

- Native attaches the delivered task and starts a 10-second claim deadline.
- JS calls `claim(submissionId)` and binds it to the durable handle.
- If JS never claims, native persists sanitized `delivery_deferred`, completes
  false once, and releases every OS handle.
- SQLite checkpoints stay untouched; generic BGProcessing/TaskManager or a
  foreground cycle later resumes them.
- Neither path resubmits the old ID or creates a background continued task.

The timeout is an implementation constant and test, not a claim that RN always
loads in ten seconds.

## 5. iOS Test 3 watcher and acceptance

At interruption begin, finalize the active monotonic WAV, publish
`paused/interrupted`, create one generation-bound `RecoveryWatcher`, and begin
one UIKit assertion. Interruption-ended, route change, resumption recommendation,
`CXCallObserver`, and app-active only set `probeRequested`; they do not reset
generation/backoff or create loops. Run at most one activation probe per second
while `backgroundTimeRemaining > 3` seconds.

Pause, Stop, Abort, successful resume, or meeting replacement cancels timers
and the assertion and invalidates stale callbacks. Deliberate Pause never
auto-resumes.

Resume order is strict:

```text
configure session -> setActive(true) succeeds -> create next chunk
-> recorder starts -> publish Recording
```

No chunk opens while the call owns audio; call audio is excluded; the meeting
ID remains unchanged.

Physical acceptance:

- rejected call 5-15 seconds: unattended resume within 5 seconds, <=3 seconds
  post-call loss;
- short answered call 15-25 seconds: same, call audio absent, post-call marker;
- long answered call 2 minutes while locked: same unattended acceptance;
- label, button, timer, and native state agree at every checkpoint.

`CXCallObserver` is a signal, not proof of an OS wake after suspension. If the
built candidate fails the locked long-call case, Test 3 remains FAILED and the
candidate is **NOT READY** unless the owner explicitly changes the criterion.
Live Activity remains a separate deferred mitigation and cannot mask this gate.

## 6. Android process-death wake

### 6.1 Options

| Option | Evidence | Decision |
| --- | --- | --- |
| Direct Expo `BackgroundTaskWork` | Private `appScopeKey`; shared Expo scheduler; package-coupled | **REJECTED** |
| Maina `CoroutineWorker` + public RN Headless JS | Public WorkManager and `HeadlessJsTaskService`; reuses shared TS recovery | **SELECTED WITH INTEGRATION PROOF GATE** |
| Expo periodic + NetInfo only | 15-minute inexact minimum; NetInfo process-alive only | **REJECTED AS SOLE OWNER**, retained as safety net |

### 6.2 Selected boundary

```text
class: MainaPipelineRecoveryWorker
unique name: maina-pipeline-network-recovery-v1
policy: KEEP
constraint: NetworkType.CONNECTED
input: wake_id UUID, wake_reason enum, requested_at
timeout: 8 minutes
```

The Worker starts `MainaPipelineHeadlessService` (public
`HeadlessJsTaskService`) with `allowedInForeground=true`. The global JS entry
registers one `MainaPipelineRecovery` task, which calls the existing
`runPipelineRecoveryCycle`. Kotlin owns no packet fields, endpoint, token,
retry engine, or outbox.

A Maina native registry maps `wake_id` to a bounded `CompletableDeferred`.
JavaScript reports completed/deferred/failed through a typed bridge. Timeout
returns `Result.retry()` under bounded WorkManager backoff. Input/
SharedPreferences is diagnostic only; SQLite/outbox state is truth.

Mandatory instrumentation proof before build acceptance:

1. WorkManager creates the Maina Worker after process death.
2. It starts the named Headless JS task on RN 0.86.3.
3. JS invokes one instrumented shared recovery callback.
4. Completion reaches that Worker.
5. `KEEP` coalesces concurrent requests and permits a new request after terminal.
6. Restart preserves durable recoverability.

Failure stops implementation; it does not authorize Expo internals.

The unique Worker owns process-death connectivity wake. Expo periodic remains
an eventual safety net; NetInfo/foreground are fast process-alive signals. If a
flap occurs while WorkManager runs, JS observes the newer durable epoch and
schedules at most one successor after the current work is terminal. No polling,
exact alarm, or second outbox is added.

## 7. Typed failures and one-shot semantics

Append schema v16 (never rewrite a shipped migration):

```text
meetings.cloud_notes_failure_class
  offline | dns | tls | socket | timeout | http_retryable | http_terminal |
  backend_retryable | backend_terminal | auth | protocol |
  transport_unknown | null
meetings.cloud_notes_failure_operation
  create | poll | provider_retry | null
meetings.cloud_notes_last_wake_epoch INTEGER

pipeline_wake_state (single row)
  connectivity_epoch INTEGER NOT NULL
  last_connected INTEGER NOT NULL
  last_claimed_epoch INTEGER
  pending_wake_token TEXT
  updated_at INTEGER NOT NULL
```

These are additive, content-free fields. Source sync retains its current durable
outbox and stable source key; it consumes the epoch without a second state
machine.

Machine mapping only:

- explicit disconnected -> `offline`;
- AbortController/`AbortError` -> `timeout`;
- structured `ENOTFOUND`/`EAI_*` -> `dns`;
- structured certificate/SSL code -> `tls`;
- structured `ECONN*`/`ENET*` -> `socket`;
- fetch failure with no structured cause code -> retryable
  `transport_unknown`; it is never mislabeled as DNS/TLS/socket in diagnostics
  or UI;
- HTTP 408/425/429/5xx -> `http_retryable`; 429 remains due-gated;
- 401/403/missing session -> `auth`;
- 400/404/409/422 or unsupported machine code -> terminal/protocol unless the
  frozen contract explicitly says retryable;
- job `failed_retryable` -> `backend_retryable`;
- `failed_auth`, `failed_validation`, `blocked_budget` -> backend terminal/auth;
- invalid success/schema -> `protocol`.

Inspect only status, backend machine code, `Error.name`, and structured
`cause.code`; never parse display text.

One SQLite transaction claims `(meetingId, connectivityEpoch, operation)`:

- no job ID + transport failure -> create once;
- job ID + transport failure -> poll that ID once;
- backend/provider retryable -> retry only when `nextRetryAt` is due;
- auth/protocol/terminal/incomplete ASR -> no automatic cloud action.

`last_wake_epoch` compare-and-set means concurrent WorkManager, NetInfo,
foreground, and periodic callbacks produce one claim. A persisted
disconnected-to-connected transition increments epoch once; repeated connected
events do not. Wake UUID is diagnostic, not authorization. Stable source key,
packet version, and existing execution serialization remain idempotency truth.
Retry count increments only for a real failed operation, using a freshly read
row in the transaction.

Android wake state is explicit:

```text
transport failure committed
  -> unique network-constrained work pending
  -> connected / Worker running
  -> Headless JS claims durable connectivity epoch
  -> create once | poll existing once | provider retry only when due
  -> ready/synced and epoch consumed
     OR durable retryable state with nextRetryAt and Worker terminal
  -> later epoch may schedule one successor
```

## 8. UI convergence and local-only refresh

SQLite is truth; pipeline signals contain only a meeting ID hint.

- Keep detail subscription.
- Home reloads its local projection after committed terminal signals.
- To-dos subscribes only when rows can change.
- Notifications reloads the local meeting/notification projection.
- Emit after transaction commit; no subscriber starts Qwen/cloud/source work.

Refresh policy:

- Home and To-dos retain their existing RefreshControl and reload local SQLite.
- Detail adds local reload of meeting, transcript, to-dos, corrections, and
  pipeline stages.
- Notifications adds local projection reload.
- Memory remains default-off with no new background refresh.
- Settings, Help, Diagnostics, Recording, and recovery/destructive forms get no
  pull-to-refresh; Diagnostics keeps its explicit action.

Split detail into `reloadLocalState()` and `maybeAdvancePipeline(trigger)`;
gesture refresh calls only the former. Indicator ends in `finally`, exposes
accessible refreshing state, and shows bounded empty/read-error UI. Repeated
refresh must create zero deltas in jobs, source keys, Qwen windows, retries,
wake epochs, or outbox rows.

## 9. Navigation

Current reproduced sequence:

1. Home pushes hidden tab `/meeting/A`.
2. global Record pushes root `/record` while A remains in tab history.
3. Save replaces the modal with `/meeting/B`.
4. Android Back exposes A.

Drawer `router.push` also duplicates hidden destinations.

| Choice | Benefit | Risk | Decision |
| --- | --- | --- | --- |
| Move only detail/recovery to outer Stack | Fixes reproduced path; preserves tabs/auxiliary screens | Detail tab bar hidden | **SELECTED** |
| Per-tab native stacks/shared detail | Tab-specific stacks | Broad restructure and nested-reset risk | **REJECTED THIS BUILD** |
| Move every auxiliary route outer | Uniform gestures | Unproven scope expansion | **REJECTED THIS BUILD** |

Only `meeting/[id]` and `meeting/[id]/recover` move outside `(tabs)`.
`record` remains root modal. Auxiliary routes stay structurally stable and get
only singleton navigation/local refresh where specified. Detail/recovery hide
the bottom tab bar as focused native detail flows; this avoids falsely
selecting Home/To-dos and is smaller than rebuilding tabs.

Notifications stays a singleton tab destination so it remains directly under
a meeting opened from a notification. Settings and Memory remain top-level
drawer destinations. Help and Diagnostics remain Settings-owned auxiliary
destinations. None has the reproduced stale-meeting/reset defect; moving them
would add route migration risk without improving Test 3 or Test 5. Their
existing header/system-back behavior must still pass physical navigation tests;
any mismatch reopens the plan before artifact build rather than silently
expanding this diff.

Use only `useNavigation` from `expo-router`, `CommonActions` from
`expo-router/react-navigation`, native Stack, and router back/navigate/replace/
dismissTo. No `@react-navigation/*` app import, custom pan, or forward swipe.

History rules:

- normal meeting/recovery entry: root push;
- deep link: root `(tabs)` anchor gives Home fallback;
- Record Cancel: dismiss to true valid origin, else Home;
- Record Save: root `CommonActions.reset` to new `(tabs)` Home plus new detail;
- recovery Keep/Open: replace recovery with saved detail;
- delete: after commit, reset to fresh Home;
- drawer: singleton `navigate`, current destination no-op;
- Home/To-dos reselect: selected tab root;
- detail header: back when possible, else replace Home.

| Screen | Entry | Back | Fallback | Tab bar | Mutation |
| --- | --- | --- | --- | --- | --- |
| Home | launch/tab/drawer/fallback | OS root behavior | Home | visible/Home | tab navigate/reset |
| To-dos | tab/drawer | prior meaningful tab | Home | visible/To-dos | tab navigate |
| Meeting detail | card/to-do/notification/save/recovery/deep link | exact origin; save -> Home | Home | hidden | root push/save reset |
| Recovery | interrupted card/detail/deep link | origin | Home | hidden | push/replace |
| Recording | mic/hardware | Cancel to origin | Home | hidden | modal push/dismiss |
| Notifications | bell/drawer | existing tab history/header | Home | visible | singleton navigate |
| Memory | enabled drawer | existing tab history/header | Home | visible | singleton navigate |
| Settings | drawer | existing tab history/header | Home | visible | singleton navigate |
| Help | Settings/drawer | Settings/origin | Home | visible | singleton navigate |
| Diagnostics | Settings | Settings/origin | Home | visible | singleton navigate |
| Delete terminal | detail | no deleted route | Home | visible | root reset |
| Deep link | verified detail/recovery URL | anchored Home | Home | hidden | anchor + push |

Required tests: Home->A->Back; To-dos->meeting->Back; Notification->meeting->
Back; A->Record->save B->Back Home; recovery replacement; delete cannot reopen;
deep-link fallback; drawer singleton; iOS detail pop/header and Android system
Back agree; tab reselect cannot resurrect meeting; route reload anchors Home.

Predictive animation is deferred; functional Android gesture destination is
required without adopting Expo's alpha ExperimentalStack.

## 10. Proposed file map after approval

Test-only first:

- `scripts/m0-replay-harness.sh`: supervised process groups, exact devices,
  PID/cmdline/log-growth preflight, fail-fast snapshots.
- preserve/integrate owner `scripts/stop-dual-device-soak.sh` only after review.
- tests for dead logger, wrong devices, zero growth.

Shared/mirrored TypeScript and SQLite:

- `src/data/db.ts`, `src/data/meetings.ts` — v16 and transactional claims.
- `src/services/mainaCloudSession.ts`, `cloudRetryPolicy.ts`,
  `meetingPacket.ts` — typed failures/operations/due-time accounting.
- `src/services/backgroundPipeline.ts`, `meetingCaptureLifecycle.ts` — shared
  wake ownership and iOS completion handle.
- `src/services/meetingPipelineSignals.ts` — hint-only semantics.
- `src/app/_layout.tsx` — root detail/recovery and anchor.
- Home/To-dos/Notifications — committed-signal subscriptions/local refresh.
- move detail/recovery to `src/app/meeting/...`; split local reload.
- `src/app/record.tsx` — supported root reset.
- `src/design/shell.tsx` and new `navigationPolicy.ts` — singleton/fallback.
- Android global entry — register one Headless JS task.

iOS native:

- `MainaIOSContinuedProcessing.swift` — unique contexts, mapping, bounds, claim
  timeout, one completion gate.
- `MainaIOSNativeAudioCapture.swift` — coalesced watcher/activation ordering.
- `MainaRecorderModule.swift` and typed TS bridge.
- config plugin/AppDelegate generation — launch registration for exact pending
  IDs; wildcard only in Info.plist.

Android native:

- supported WorkManager dependency, no Expo-worker dependency.
- `MainaPipelineRecoveryWorker.kt`.
- `MainaPipelineHeadlessService.kt`.
- native wake/completion registry and typed module bridge.
- manifest/config-plugin service entry.
- `MainaPostProcessingService.kt` schedules wake after durable transport state;
  no endpoint/payload/token logic.

No Backend/Web file changes.

## 11. Automated gates before artifacts

iOS:

- unique IDs across retries/two meetings; repeated active begin has no delta;
- exact launch registration once; bounds/pruning/orphan handling;
- late claim/no-claim/terminal late delivery;
- foreground nonblocking and OS worker awaiting same handle;
- completion once under normal/expiration/cancel/timeout races;
- mid-window expiration promptly releases OS and replays at most uncommitted
  window;
- one watcher under simultaneous call/audio/app signals; Stop/Pause cancels;
- activation precedes chunk; call audio absent; post-call marker present.

Android/shared:

- WorkManager -> public Headless JS -> shared TS -> Worker completion after
  process death;
- KEEP coalescing and terminal reschedule;
- one epoch under concurrent WorkManager/NetInfo/foreground/periodic signals;
- create/poll/provider due-time cases and typed failure matrix;
- one flap, stable job/packet/source identities, accurate attempt count.

UI:

- all navigation cases above;
- Home/detail/To-dos/Notifications converge after one committed signal without
  relaunch;
- repeated local refresh has zero pipeline/outbox deltas;
- indicator success/failure/accessibility.

Run changed-surface/full release suites for recording, ASR/checkpoints, partial
coverage, packet, source sync, corrections, To-dos, sharing, retention/cleanup,
secure session, Memory owner isolation/default-off flags, contract import,
typecheck, lint, native verifiers, and shared-file parity.

## 12. Artifact-first boundary and atomic manifest

After Admin approves implementation:

1. Fix/verify harness in a test-only commit.
2. Implement one coherent increment; run focused tests.
3. Require `df -Pk /System/Volumes/Data` >=20 GiB. Cleanup only rebuildable
   closed intermediates inside authorized Maina paths; never device/app/user
   data, recordings, backups, credentials, or evidence.
4. Run full changed-surface/release gates.
5. Build one Android APK and one signed iOS app/archive **without installing**.
6. Verify version/package/bundle/signature and compute SHA-256.
7. Write final atomic manifest and **HOLD**.
8. Present artifacts/manifest for explicit Admin/owner review.
9. Only after approval, install in place without uninstall/clear-data.
10. Capture retained recording/meeting/schema counts before/after first launch.
11. Replay physical Tests 3/5/navigation/refresh.
12. Submit freeze handoff for independent Admin qualification.

Manifest fields:

- exact Android/iOS/coordination commits;
- Backend `6b2bcf43...`, Web `5b11bb02...`, deployment IDs, imported contract
  checksum;
- version/build, path, size, SHA-256, Android signing fingerprint, iOS identity
  and Personal Team expiry;
- every changed file grouped shared/iOS/Android/test/docs;
- v16 migration/data-preservation proof;
- included fixes and exclusions: Live Activity, iOS 27 API, predictive animation,
  Backend/Web work, per-tab redesign;
- default-off flags;
- focused/full test counts and native/contract/parity results;
- unresolved residuals and rollback;
- post-approved-install counts and physical evidence.

No second broad build without a changed surface and manifest delta.

## 13. Rollback, residuals, and go/no-go

Rollback/data preservation:

- v16 is additive; older code ignores nullable fields/table.
- cancel versioned WorkManager work without touching SQLite/audio/outbox.
- disable/clear iOS submission registry independently of meeting/audio data;
  never reuse terminal IDs.
- route changes do not alter meeting IDs/content.
- rollback by compatible in-place signed install only; never uninstall/clear.
- preserve recordings, transcript blocks, SQLite, secure session, outboxes,
  diagnostics, and owner harness files.

Unresolved residuals:

- Sherpa cannot abort mid-window; expiration may waste one window of compute.
- iOS may offer no public wake after a long answered call; physical failure is
  release-blocking unless owner changes acceptance.
- WorkManager->Headless JS is selected but target instrumentation remains a
  hard proof gate.
- iOS 26 reports only synchronous submit errors; iOS 27 delayed errors deferred.
- force-swipe can terminate Apple work; checkpoints preserve committed data.
- predictive animation deferred; destination correctness mandatory.

GO to artifacts only after Admin approval, public Headless JS proof, all gates,
>=20 GiB, no duplicate owners/contract change, and live harness preflight.

GO to install only after explicit review of manifest, hashes, signatures,
migration, rollback, tests, and residuals.

GO to freeze only after data-preserving first launch; all rejected/short/long
Test 3 calls pass unattended; Test 5 recovers from offline/process death/flap
without Retry/foreground and yields one canonical source; UI/navigation/refresh
pass; and Admin independently qualifies.

## 14. References

- Apple long-running tasks/unique job IDs:
  https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados/
- Apple foreground requirement:
  https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest
- Apple registration lifecycle:
  https://developer.apple.com/documentation/backgroundtasks/bgtaskscheduler/register(fortaskwithidentifier:using:launchhandler:)
- Apple audio interruption:
  https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification
- React Native Headless JS: https://reactnative.dev/docs/headless-js-android
- Android WorkManager:
  https://developer.android.com/develop/background-work/background-tasks/persistent
- Android unique work:
  https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work
- Expo BackgroundTask:
  https://docs.expo.dev/versions/v57.0.0/sdk/background-task/
- Expo Router SDK 57: https://docs.expo.dev/versions/v57.0.0/sdk/router/
- Supported reset import:
  https://docs.expo.dev/router/migrate/from-react-navigation/

## 15. Round 2 disposition

| # | Issue | Disposition |
| --- | --- | --- |
| 1 | Correct source pins | **ACCEPTED / CHANGED** — historical pin identified; frozen pins restored; no contract change |
| 2 | Never reuse iOS identifier | **ACCEPTED / CHANGED** — per-submission sequence+UUID, exact registration, bounds, concurrency/relaunch rules |
| 3 | Expiration safety | **ACCEPTED / CHANGED** — last committed truth, 1-second fail-safe, recomputation acknowledged |
| 4 | RN-not-ready/late attach | **ACCEPTED / CHANGED** — 10-second claim, exactly-once false completion, no background resubmit |
| 5 | Android wake design | **ACCEPTED WITH PROOF GATE** — private Expo worker rejected; public Maina Worker/Headless JS selected; instrumentation blocking |
| 6 | Typed retry/one-shot | **ACCEPTED / CHANGED** — v16, machine mapping, operation/epoch transaction, due-time protection |
| 7 | Navigation | **ACCEPTED / CHANGED** — outer detail/recovery only; broader rewrites rejected; matrix/reset specified |
| 8 | Local-only refresh | **ACCEPTED / CHANGED** — reload split and zero-side-effect tests |
| 9 | Test 3 truth | **ACCEPTED / BLOCKING** — long-call automatic resume remains NOT READY until physical pass or owner changes criterion |
| 10 | Artifact review before install | **ACCEPTED / CHANGED** — tests/disk, artifacts only, manifest HOLD, approval, then in-place install |
| 11 | Atomic manifest | **ACCEPTED / CHANGED** — contents, exclusions, rollback, residuals, and staged go/no-go defined |
