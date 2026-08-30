# Maina Apps reliability implementation manifest — 2026-08-30

## Decision state

The approved reliability base is implemented and reviewable. It is **not a
release candidate yet**: no APK, iOS archive, IPA, app install, device data
change, or physical replay was performed in this phase.

Implementation pins before this manifest:

- Android/shared: `36f3844516326723862cba047d98b6b72a61421e`
- iOS: `8772ea476d70c17f11731e412bf0f5e0cebd3431`
- Shared coordination: `11356bf32e738cd022fa68e184bd8d9f5314eda2`
- Frozen Backend source: `6b2bcf43c2e8c4fb7c40a6cb6fb49e643099f93b`
- Frozen Web source: `5b11bb026ff5fff36c7b393add9c0c64986a1335`
- Historical Release A schema-publication pin consumed by the generated mobile
  decoder: `57cbb52`. This is a contract lineage pin, not the frozen Backend
  release input and not a request to change Backend.

Both Git worktrees were clean at the implementation boundary. Shared
`package.json`, `index.js`, `modules/maina-recorder/src`, and `src` files were
byte-identical between Android and iOS. Intentional native and harness
differences remain outside that parity set.

The sanitized phase handoff was subsequently recorded in shared coordination
at `21fba09` without changing product code or any runtime contract.

## Plain-English included changes

### Android

- A call or communication session now owns a typed system-pause state. Maina
  closes the current WAV chunk before yielding the microphone and cannot be
  manually forced to resume while the call still owns audio.
- Resumption keeps the same meeting, allocates and fsyncs the next monotonic
  partial WAV/journal identity before starting `AudioRecord`, and publishes
  `Recording` only after Android confirms microphone ownership.
- A bounded, network-constrained WorkManager bridge can wake the existing
  shared TypeScript pipeline. It owns no packet, transcript, provider key, or
  second outbox.
- Wireless ADB harness selection fails closed unless it identifies the exact
  authorised Pixel. A stale USB/emulator target cannot be selected silently.

### iOS

- Interruption recovery starts while iOS still grants background time, merges
  duplicate route/interruption/foreground signals, retries at a capped cadence,
  and keeps the call interval outside the meeting audio.
- Every continued-processing submission has a never-reused identifier and one
  completion gate. An unclaimed OS task times out safely instead of leaking an
  execution assertion.
- A single static, network-constrained BGProcessing request wakes the same
  durable pipeline after offline work. It coalesces requests and has a bounded
  native scheduling budget.
- Background recovery can use a delivered BGProcessing owner, but it never
  creates a new continued-processing assertion from the background.
- Late Qwen callbacks are fenced by run/window generation and cannot commit
  after an OS execution owner expires.

### Shared pipeline, truth, UI and navigation

- One additive schema-v16 migration stores typed capture state, typed cloud
  failure classes, durable wake generations/leases, ASR claims, and verified
  cleanup state. There is no v17 migration and no second queue.
- Reconnect, foreground, native progress, periodic recovery, Android Worker,
  and iOS BGProcessing signals all persist into one SQLite generation before
  in-process coalescing. A reconnect arriving during generation N creates one
  durable N+1; it is not discarded.
- Dead wake leases can be reclaimed. Obsolete workers are true no-ops. Native
  enqueue failures remain visible as `enqueue_required` and are repaired by
  startup plus the existing periodic safety path.
- Offline/DNS/TLS/socket/timeout/HTTP/provider failures use typed behavior.
  User screens show safe actionable language and never raw exception classes,
  production hostnames, provider errors, or tokens.
- Terminal audio deletion is event-driven, verified natively before clearing
  the DB pointer, retryable, and coalesced per meeting.
- Measured recorded-audio duration is monotonic. Wall elapsed time and call
  gaps cannot replace it after relaunch.
- Meeting detail moved to a native outer stack. Native Back returns to the
  meaningful origin (Home, To-dos, or Notifications); a newly saved meeting,
  orphan, or deep link falls back to Home. No custom forward swipe exists.
- Pull-to-refresh is local SQLite/view reload only. It cannot start Qwen,
  create/poll a notes job, sync a source, reset backoff, or act as Retry.
- Transcript/Notes/To-dos tab sizing and terminal pipeline presentation were
  tightened without a broad visual redesign.

## Required state transitions

### Test 3 — call interruption

Android:

```text
recording
  -> persist system_pause_pending + generation
  -> close/fsync active chunk
  -> system_paused
  -> communication clear (coalesced callbacks)
  -> allocate/fsync next partial WAV + journal identity
  -> activate/verify AudioRecord ownership
  -> persist recording + new chunk sequence
```

iOS:

```text
recording
  -> AVAudioSession interruption began
  -> close durable chunk; communication-paused
  -> one bounded UIKit background watcher
  -> interruption/route/active signals coalesce
  -> AVAudioSession activation + new monotonic chunk succeeds
  -> recording in the same meeting
```

Manual Pause never auto-resumes. Manual Resume fails closed during active
communication. Stop/Abort invalidate the recovery generation. If the OS no
longer grants execution, Maina remains truthfully paused/partial; it does not
claim success. Therefore rejected, short answered, and long answered/locked
calls remain mandatory physical gates on both devices.

### Test 5 — offline recovery

```text
transport failure or reconnect signal
  -> SQLite persists typed failure + wake generation/enqueue_required
  -> one network-constrained native request
  -> native token claims one leased generation
  -> shared TypeScript drains existing ASR/packet/source/correction outboxes
  -> create absent job once OR poll the same existing job once
  -> provider/server retry remains due-time gated
  -> immutable source key/job id remains stable
  -> durable completion; any pending N+1 is scheduled
```

SQLite and the OS scheduler are not one transaction. A process death between
the DB commit and OS enqueue is recovered on startup or by the existing inexact
periodic safety path. iOS BGProcessing and Android periodic work are
opportunistic; the accepted product gate is still three physical locked runs
per platform completing within 30 minutes without foregrounding or Retry.

## F-001 through F-014 disposition

| ID | This increment | Automated evidence | Remaining gate / verdict |
| --- | --- | --- | --- |
| F-001 | Event-driven, coalesced, native-verified terminal audio cleanup | Cleanup success, failure-retention, and duplicate-signal tests pass | Physical terminal deletion and DB-pointer convergence required; blocking P1 until replay |
| F-002 | Event-driven capture/pipeline refresh retained; no wall-time substitution | Duration/checkpoint tests pass | Observe unlock repaint during physical replay; non-blocking only if native duration/audio remain continuous |
| F-003 | Retention removed from meeting-screen advancement; terminal events own cleanup | Background pipeline ordering and cleanup coalescing pass | Log-frequency audit during replay/soak; P2 |
| F-004 | No destructive historical repair | Legacy data remains preserved | Explicitly deferred historical orphan; non-blocking for new meetings |
| F-005 | No model/runtime rewrite in this bounded increment | Native/runtime integrity checks pass | iOS release memory plateau, CPU diagnostic, jetsam/termination soak is mandatory; blocking P1 |
| F-006 | Harness forbids active-test terminate/force-stop and proves monitor liveness | Both harness safety verifiers pass | Closed in test tooling; physical preflight still required |
| F-007 | No ASR-model change | Transcript durability tests remain green | Accepted source/model-quality artifact; not capture loss and non-blocking |
| F-008 | Bounded iOS interruption watcher and same-meeting chunk continuation | Swift typecheck/static invariants pass | Rejected/short/long locked calls must auto-resume physically; blocking P0 |
| F-009 | Terminal heartbeat/presentation follows durable capture/pipeline state | Native reconciliation/presentation tests pass | Physical stale-modal/heartbeat replay required; blocking P1 |
| F-010 | Typed Android communication ownership and privacy pause | 57 Android native tests include command/interleaving policy cases | WhatsApp/phone rejected/short/long locked call proof with zero call text required; blocking P0 |
| F-011 | Audio duration is sourced from native measured chunks and remains monotonic; gap is separate | Checkpoint and reconciliation tests pass | Relaunch/process-death duration replay required; blocking P1 |
| F-012 | Retryable transport state + durable generation + native wakes | Scheduler/coordinator/headless/failure tests pass | Three locked offline-to-online runs within 30 minutes on each platform; blocking P0 |
| F-013 | Android network Worker wakes the same immutable source outbox | Worker policy, scheduler and idempotency tests pass | Physical one-source/no-duplicate convergence required; blocking P1 |
| F-014 | Safe failure-code-to-copy mapping; raw causes stay in bounded diagnostics | UnknownHost/hostname leakage tests pass | Physical offline UI inspection required; P2 |

## Automated qualification completed

Both Android and iOS shared branches:

- TypeScript typecheck: passed.
- Vitest: **56 files / 242 tests passed** on each branch.
- Expo lint: passed with zero warnings and zero errors.
- Release A generated-contract/hash gate: passed.
- Shared native-recorder/Sherpa integrity: passed.
- M0 harness safety: passed.
- weekly renewal safety: passed.
- coordination: passed at **123 events / 51 workplan items**.

Platform-specific:

- Android Gradle native unit tests: **13 suites / 57 tests passed**.
- iOS verifier: capture, continued-processing, pipeline-wake and Qwen Swift
  sources typechecked against the iPhoneOS SDK; Info.plist/plugin capability
  boundaries passed.
- Shared-source parity: no differences in the declared parity set.

These checks prove implementation consistency, not unattended physical
behavior. Android Worker-to-ReactHost-to-Headless-JS execution and iOS OS-task
delivery remain unconditional post-install physical gates.

## Migration, data preservation and rollback

- Shipped/installed candidates are recorded at schema v15. Source contains one
  consolidated, additive v16 migration; no v16/v17 artifact has been built or
  installed in this phase.
- Before any future install, read the exact live schema on both phones. If
  either is unexpectedly v16 or later, stop and add a new forward-only
  migration; never edit migration history.
- The migration adds nullable/defaulted columns and two small control tables.
  It does not rewrite or delete meetings, recordings, transcript blocks,
  notes, corrections, account sessions, or MKC source keys.
- Rollback after a future install is an in-place install of the prior signed
  app with the same bundle/application ID. Never uninstall or clear data.
  The prior app ignores additive columns/tables; a stale OS wake may fail once
  but owns no user content. Durable meeting/outbox rows remain canonical.
- Memory feature flags remain default-off. They can be disabled independently
  without affecting recording, ASR, notes, To-dos, sharing, or sync.

## Proposed artifact identities — not yet applied

- Android: `0.10.35` (`versionCode 61`)
- iOS: `0.10.35` (`buildNumber 17`)

Current installed devices remain untouched on Android `0.10.34 (60)` and iOS
`0.10.34 (16)`. No new signature, SHA-256, signing expiry, APK, archive, IPA,
or `.app` exists yet.

The current Mac data volume has only about **11 GiB free**. Artifact creation is
hard-blocked until at least **20 GiB** is available. Any future cleanup must be
limited to authorised, rebuildable Maina caches/intermediates and logged.

## Explicit exclusions

- No Backend/Web, API contract, packet, source-key, prompt, provider, key,
  session, tenant, or authentication change.
- No direct provider execution or prompt/provider controls on mobile.
- No Live Activity, Action Button integration, iOS 27-only API, custom forward
  swipe, predictive-back animation, exact alarm, unrestricted foreground
  service, private Expo worker, second datastore/outbox/retrieval engine, or
  unbounded polling.
- No ASR model replacement and no repair of the historical 2026-08-27 orphan.
- Memory Releases A–C remain default-off and are not promoted by this
  reliability increment.
- No artifact build, install, uninstall, device launch, data clear, DB reset,
  recording deletion, or physical qualification.

## Complete changed-file manifest

Android/shared changed paths since `47d5a86`:

```text
docs/APPS_RELIABILITY_IMPLEMENTATION_MANIFEST_2026-08-30.md
docs/SHARED_CONVERGENCE_INVENTORY_2026-08-30.md
index.js
modules/maina-recorder/android/build.gradle
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaAudioOwnershipPolicy.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCallInterruptionPolicy.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaCaptureControlStore.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaNativeAudioCapture.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPipelineWakeWorker.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingOutbox.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaPostProcessingService.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecorderModule.kt
modules/maina-recorder/android/src/main/java/com/divay/maina/recorder/MainaRecordingService.kt
modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaAudioOwnershipPolicyTest.kt
modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaCallInterruptionPolicyTest.kt
modules/maina-recorder/android/src/test/java/com/divay/maina/recorder/MainaPipelineWakePolicyTest.kt
modules/maina-recorder/src/index.ts
package.json
scripts/adb-target.sh
scripts/adb-usb.sh
scripts/install-android-preserving-data.sh
scripts/m0-replay-harness.sh
scripts/maina-env.sh
scripts/verify-m0-harness-safety.mjs
scripts/verify-m0-replay-harness.mjs
src/app/(tabs)/_layout.tsx
src/app/(tabs)/diagnostics.tsx
src/app/(tabs)/help.tsx
src/app/(tabs)/index.tsx
src/app/(tabs)/notifications.tsx
src/app/(tabs)/settings.tsx
src/app/(tabs)/todos.tsx
src/app/_layout.tsx
src/app/meeting/[id].tsx
src/app/meeting/[id]/recover.tsx
src/app/meeting/_layout.tsx
src/app/record.tsx
src/core/navigation/navigationPolicy.test.ts
src/core/navigation/navigationPolicy.ts
src/core/pipeline/cloudFailure.test.ts
src/core/pipeline/cloudFailure.ts
src/core/pipeline/keyedExecutionOwner.test.ts
src/core/pipeline/keyedExecutionOwner.ts
src/core/pipeline/pipelineWakeState.test.ts
src/core/pipeline/pipelineWakeState.ts
src/core/recording/appFileReference.test.ts
src/core/recording/appFileReference.ts
src/core/recording/audioLevel.test.ts
src/core/recording/audioLevel.ts
src/core/recording/checkpoint.test.ts
src/core/recording/checkpoint.ts
src/core/recording/nativeCaptureReconciliation.test.ts
src/core/recording/nativeCaptureReconciliation.ts
src/core/transcription/asr/localAsrClaimPolicy.test.ts
src/core/transcription/asr/localAsrClaimPolicy.ts
src/data/db.ts
src/data/meetings.ts
src/data/pipelineWake.ts
src/design/components.tsx
src/design/shell.tsx
src/hardware/pipelineWake.ts
src/hardware/recording/foreground.ts
src/hardware/recording/nativeCaptureLifecycle.ts
src/headless/pipelineWakeTask.test.ts
src/headless/pipelineWakeTask.ts
src/headless/registerPipelineWake.ts
src/services/audioRetention.test.ts
src/services/audioRetention.ts
src/services/audioRetentionCore.test.ts
src/services/audioRetentionCore.ts
src/services/backgroundPipeline.ts
src/services/backgroundPipelineCore.test.ts
src/services/backgroundPipelineCore.ts
src/services/cloudRetryPolicy.ts
src/services/iosAsrRecoveryPolicy.test.ts
src/services/iosAsrRecoveryPolicy.ts
src/services/localAsrCheckpointCore.test.ts
src/services/localAsrCheckpointCore.ts
src/services/localAsrPipeline.ts
src/services/mainaCloudSession.test.ts
src/services/mainaCloudSession.ts
src/services/mainaKnowledgeCloud.test.ts
src/services/mainaKnowledgeCloud.ts
src/services/mainaKnowledgeCloudCore.ts
src/services/mainaKnowledgeCloudCorrections.test.ts
src/services/mainaKnowledgeCloudCorrections.ts
src/services/meetingCaptureLifecycle.ts
src/services/meetingPacket.test.ts
src/services/meetingPacket.ts
src/services/meetingPresentation.test.ts
src/services/meetingPresentation.ts
src/services/notifications.ts
src/services/pipelineWakeCoordinator.test.ts
src/services/pipelineWakeCoordinator.ts
src/services/pipelineWakeScheduler.test.ts
src/services/pipelineWakeScheduler.ts
src/services/transcriptCoverage.test.ts
src/services/transcriptCoverage.ts
```

iOS-specific/branch changed paths since `8c08fcc`, in addition to the shared
paths above that are present on both branches:

```text
app.json
coordination
modules/maina-recorder/ios/MainaIOSContinuedProcessing.swift
modules/maina-recorder/ios/MainaIOSNativeAudioCapture.swift
modules/maina-recorder/ios/MainaIOSPipelineWake.swift
modules/maina-recorder/ios/MainaRecorderModule.swift
plugins/withMainaIOSContinuedProcessing.js
scripts/verify-ios-native-recorder.mjs
scripts/verify-m0-harness-safety.mjs
```

The exact source diff also includes the shared-path subset on iOS. Renamed
meeting routes preserve history; they are not delete/recreate data operations.

## Artifact and promotion gates

Before an artifact may be built:

1. Recover at least 20 GiB free space within authorised Maina-only boundaries.
2. Re-run all gates above and capture exact live DB schema versions.
3. Apply proposed version/build numbers and build exactly one APK and one signed
   iOS app/archive, without installing.
4. Record hashes/signatures/signing expiry and hold for owner/Admin review.

After explicit install approval, in-place installation must preserve all data,
then pass:

- Test 3 on both devices: rejected, short answered, and long answered/locked
  calls; automatic same-meeting resume; no call-interval transcript; post-call
  marker; truthful timer/state.
- Test 5 on both devices: three locked offline-to-online runs within 30 minutes,
  one network flap, no foreground/Retry, no duplicate job/source.
- Native Back/navigation matrix and local-only pull-refresh matrix.
- iOS terminal audio deletion, stale-modal/heartbeat, duration after relaunch,
  and long-ASR memory plateau/no jetsam.
- Android Worker-to-ReactHost-to-Headless-JS invocation on the exact Wi-Fi
  Pixel, plus UI convergence after source HTTP success.

Any miss leaves the verdict **NOT READY**. Current declaration:

> Implementation complete and ready for independent code review. No artifact
> was built or installed. Apps are not ready to freeze or promote until the
> held artifact and physical gates pass.
