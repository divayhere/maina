# Android durable pipeline wake — revised implementation amendment

Date: 2026-08-30  
Status: implementation and focused tests complete; artifact build/install not authorized
Scope: Android Test 5 process-death wake only

## Decision

The first `APPEND_OR_REPLACE` design is rejected. It could retain a dead
SQLite claim, retry forever, and let every stale Worker manufacture another
generation. The revised design has one durable truth and bounded ownership:

1. Expo SQLite `pipeline_wake_state` owns whether work exists.
2. WorkManager owns only a bounded OS execution window.
3. A renewable SQLite lease owns one shared TypeScript drain.
4. A native completion token owns one WorkManager attempt.
5. Packet/source/auth logic remains exclusively in the shared TypeScript
   pipeline and existing idempotent backend contract.

No foreground service, Expo-private Worker, exact alarm, second outbox,
second JS engine, new permission, backend contract, or Web change is added.

The canonical MKC integration registry was audited after implementation. This
amendment changes no repository ownership, endpoint, API contract, source key,
connector, non-secret cloud resource ID, binding, environment/secret name,
required scope, deployment version, provider/prompt ownership, or correction
lineage, so no registry entry is required. The optional Documents mirror and
its workstate were unavailable through macOS permissions; that mirror is not a
build/deploy prerequisite and no attempt was made to overwrite it.

Frozen external inputs remain:

- Backend source: `6b2bcf43c2e8c4fb7c40a6cb6fb49e643099f93b`
- Web source: `5b11bb026ff5fff36c7b393add9c0c64986a1335`

## 1. Durable claim death-lock

### Source rule

Each SQLite claim stores:

- `active_attempt_token`
- `active_attempt_generation`
- `active_attempt_lease_until`

The lease is 60 seconds and a live task renews it every 15 seconds and before
each recovery stage. Claim and reclaim decisions run inside one exclusive
SQLite transaction.

- A matching generation with a live lease returns `busy`.
- A matching generation with an expired lease atomically replaces the old
  token and returns `reclaimed`.
- The old process cannot renew or complete after replacement because both
  operations use `WHERE active_attempt_token = ?`.
- A failed/expired owner leaves `enqueue_required = 1`; no work row is
  deleted.

The v17 migration adds the lease/generation columns with
`addColumnIfMissing`. This is required because a staging device may already
have opened v16. It preserves every meeting, audio, transcript, packet, source,
and retry row.

### Death-boundary behavior

| Boundary | Durable state | Recovery |
| --- | --- | --- |
| Before claim | Pending generation, no token | Same generation is claimed |
| After claim | Token plus renewable lease | Busy until expiry, then one reclaim |
| During any stage | Same token; stage checkpoints fence ownership | Resume/replay after lease expiry |
| After durable success, before native completion | No pending work, no token | Retry Worker returns `no_work` |
| Old callback after reclaim | Token mismatch | Cannot commit/complete newer ownership |

## 2. Bounded WorkManager retries

Work is no longer appended to a chain. Every shared generation uses a unique
name:

`maina-durable-pipeline-wake-v2-shared-g<generation>`

Every native result uses a SHA-256-derived run fingerprint. WorkManager uses
`ExistingWorkPolicy.KEEP`, so duplicate scheduling of an unfinished exact
generation/run is a no-op; different generations are independent and SQLite
still permits only one effective drain.

The Worker has five total execution attempts. Launch failure, JS failure,
busy lease, or the 100-second native completion timeout returns `retry` only
while `runAttemptCount + 1 < 5`; the fifth execution returns terminal failure.
Requested exponential delays are 15/30/60/120 seconds. Android can delay work
further, so this is an execution bound, not a wall-clock completion promise.
Maximum app-owned execution is five attempts, each bounded by a 30-second
React start plus a 100-second completion wait.

Terminal Worker failure does not delete or terminalize the SQLite/outbox work.
A later genuine foreground, connectivity, Expo periodic, or exact native-run
signal may enqueue the same generation again. `KEEP` only suppresses a new
request while same-name work is unfinished; it does not create an unbounded
chain.

## 3. Generation contract and true no-op Workers

A shared WorkManager invocation receives an already committed generation and
calls `beginPipelineWakeAttempt(expectedGeneration)` directly. It never calls
`requestPipelineWake`.

- Older generation: `obsolete`, native success, no drain.
- Completed generation: `no_work`, native success, no drain.
- Live owner: `busy`, bounded native retry.
- Pending/expired owner: claim/reclaim and one shared drain.

The only native Worker allowed to request a generation is a terminal native
ASR-result wake. Before doing so, JS reads the existing native post-processing
outbox and verifies the exact meeting ID, run ID, and terminal/deferred state.
A stale run is a successful no-op. The durable native outbox—not a timestamp
or Worker—is the request source.

Concurrent foreground, connectivity, and native signals coalesce into one
pending generation. A signal arriving during an active drain creates one
follow-up generation even when it repeats the same durable run key; later
signals coalesce into it. This avoids `KEEP` suppressing follow-up work against
the still-running earlier generation.

## 4. React Native 0.86.3 lifecycle

`currentReactContext != null` is not treated as readiness.

The Worker thread:

1. Registers a unique native completion token.
2. Calls public `ReactHost.start()` unconditionally and waits at most 30
   seconds off the UI thread.
3. Rejects cancelled/faulted initialization.
4. Reads the initialized context and checks `hasActiveReactInstance()`.
5. Switches to the UI thread, re-reads `ReactHost.currentReactContext`, requires
   object identity with the initialized context, checks active state again,
   starts `HeadlessJsTaskContext`, and immediately rechecks active state.
6. Rejects launch if the token was cancelled during this handoff.

Local React Native 0.86.3 source documents that `ReactHost.start()` completes
when the React instance is initialized and that waiting on UI can deadlock.
`HeadlessJsTaskContext.startTask()` itself only logs a soft exception when the
instance is inactive, which is why the identity/active checks are explicit.

This direct bridge uses public APIs but is not claimed as a framework-level
supported WorkManager integration. Physical Worker -> ReactHost -> Headless JS
-> shared TypeScript -> Worker completion after separately approved in-place
installation remains an unconditional gate. A failure is NO-GO; there is no
fallback to private Expo/RN APIs or a foreground service.

Primary references:

- React Native 0.86 Headless JS:
  https://reactnative.dev/docs/0.86/headless-js-android
- ReactHost source/API:
  https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactHost.kt
- Headless task context source/API:
  https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/jstasks/HeadlessJsTaskContext.kt
- Android unique work and cancellation:
  https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work
- WorkManager API:
  https://developer.android.com/reference/androidx/work/WorkManager.html

## 5. Exactly-one completion ownership

The native token registry uses `putIfAbsent` and atomic `remove`.
`complete(token, result)` or `abandon(token)` can win once; every later call is
a no-op.

The JS task owns one `completeNativePipelineWake(...)` attempt in `finally`,
including malformed data and exceptions before a SQLite claim.

| Outcome | Native token | SQLite lease | Worker result |
| --- | --- | --- | --- |
| Success/no-work/obsolete | Complete true once | Cleared or unchanged no-work | Success |
| Live competing owner | Complete false once | Other owner retained | Bounded retry |
| JS rejection | Complete false once | Failure requeued | Bounded retry |
| Headless/native timeout | Worker abandons once | JS loses active-token check; lease is requeued or expires | Bounded retry |
| Worker cancellation | Coroutine `finally` abandons once | JS is fenced; process death leaves expiring lease | WorkManager-owned reschedule semantics |
| Process death | In-memory token disappears | Lease remains durable, then reclaimable | Later execution/reconciliation |
| Native-token loss | `isActive` fails at next stage boundary | Current attempt requeued or lease expires | Bounded retry |

No cancellation path deletes durable work. If inference/network code cannot be
interrupted inside one awaited operation, that operation may finish, but it
cannot advance the next stage or complete the lease after native-token/lease
loss. Existing packet/source idempotency contains a duplicate response at that
boundary.

## 6. Commit/enqueue crash window

Expo SQLite and WorkManager cannot share an atomic transaction. The safe order
is therefore:

1. Commit `enqueue_required = 1` and its generation in SQLite.
2. Enqueue same-generation unique WorkManager work.
3. Record `last_enqueued_generation` only as diagnostics.

If enqueue throws or the process dies between steps 1 and 2, SQLite remains
pending. Foreground/startup reconciliation or the already registered Expo
periodic task services that exact generation; it does not create a second
outbox. If WorkManager accepted the request but step 3 did not run, the Worker
still services the same SQLite generation and the diagnostic marker is merely
stale.

This is intentional at-least-once scheduling with idempotent shared work, not
an assertion of cross-database atomicity.

## Changed files in this amendment

Shared TypeScript:

- `src/core/pipeline/pipelineWakeState.ts`
- `src/core/pipeline/pipelineWakeState.test.ts`
- `src/data/db.ts`
- `src/data/pipelineWake.ts`
- `src/services/backgroundPipelineCore.ts`
- `src/services/backgroundPipelineCore.test.ts`
- `src/services/backgroundPipeline.ts`
- `src/services/pipelineWakeScheduler.ts`
- `src/services/pipelineWakeScheduler.test.ts`
- `src/services/meetingCaptureLifecycle.ts`
- `src/headless/pipelineWakeTask.ts`
- `src/headless/pipelineWakeTask.test.ts`
- `src/headless/registerPipelineWake.ts`
- `src/hardware/pipelineWake.ts`
- `src/app/_layout.tsx`

Android native/module boundary:

- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPipelineWakeWorker.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt`
- `modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt`
- `modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaPipelineWakePolicyTest.kt`
- `modules/maina-recorder/src/index.ts`
- `scripts/verify-native-recorder.mjs`

## Focused acceptance tests

Implemented automated cases:

1. Concurrent signals coalesce into one pending generation.
2. A signal during an active attempt creates one follow-up generation.
3. Death before/after claim and during a stage becomes claimable after lease
   expiry without parallel ownership.
4. Durable success before native completion makes a retry Worker `no_work`.
5. Obsolete Worker creates no generation.
6. Exact native run creates one generation; stale native run is a no-op.
7. Native completion succeeds once; duplicate complete/abandon fails.
8. Retry attempts are terminal on attempt five.
9. Same generation/run has one unique work name; different generations/runs
   do not chain.
10. Malformed data and JS exceptions complete native false exactly once.
11. Stage ownership is checked between local repair, ASR, retention, notes,
    source sync, corrections, and diagnostics.
12. Concurrent callers execute one effective shared outbox drain.
13. Native enqueue failure leaves SQLite pending and later reconciles the
    existing generation without creating another durable row.

Current evidence:

- TypeScript typecheck: pass.
- Expo lint: pass.
- Native recorder source/runtime invariant verifier: pass.
- Focused shared tests: 35/35 pass across seven files.
- Full shared suite: 220/220 pass across 50 files.
- Android native module compile: pass.
- Android native behavioral suite: 48/48 pass, including 6/6 wake-policy cases.

These are static/focused gates, not physical process-death evidence. No APK,
app archive, install, uninstall, data clear, recording deletion, or device
mutation occurred.

## Rollback

Remove the app-owned Worker/Headless bridge and retain foreground plus existing
Expo periodic recovery. The additive v16/v17 fields remain harmless to older
code. No meeting/audio/transcript/source row is transformed or deleted by the
rollback.

## Remaining hard gate

After an artifact is separately reviewed and installation is explicitly
approved, physical qualification must prove:

1. Process-alive reconnect and process-death reconnect both start the public
   Worker/JS bridge.
2. Concurrent network/foreground/Worker signals yield one packet job, one
   source key, stable job ID/hash, and stable retry accounting.
3. Killing at request commit, after claim, during each recovery stage, and
   after durable success recovers without manual foreground/Retry.
4. Five failed executions terminate native retries while SQLite/outbox work
   remains recoverable by a later genuine signal.
5. No raw host, exception, token, or provider error reaches UI.

Until that physical bridge proof passes, Android Test 5 and promotion remain
**NOT READY**. No build or installation approval is requested by this document.
