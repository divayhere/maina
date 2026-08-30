# Android durable pipeline wake — implementation amendment

Date: 2026-08-30  
Status: review required; product implementation paused  
Scope: Android Test 5 process-death wake only

## Why the accepted premise needs amendment

The frozen Round 3 plan selected an app-owned WorkManager `CoroutineWorker`
that starts a `HeadlessJsTaskService`. Source implementation and compilation
research found two problems that must not be hidden behind a successful build:

1. Android target SDK 36 does not permit an ordinary background `Service` to
   be started from a background Worker after process death. React Native's
   current Headless JS guide now demonstrates `startForegroundService`, while
   Android requires a foreground service to promote itself and restricts
   background foreground-service starts. Adding that service/notification/
   permission expansion is explicitly excluded by the approved plan.
2. The approved phase order requires a physical Worker -> React Native ->
   shared TypeScript -> Worker completion proof before artifact creation, but
   also forbids installing any implementation before the artifacts are built
   and reviewed. A new native/JS bridge cannot be exercised on the existing
   installed binary. Compilation or a mocked JVM test is not truthful runtime
   proof.

Primary platform references:

- React Native Headless JS Android:
  https://reactnative.dev/docs/headless-js-android
- Android background service limits:
  https://developer.android.com/reference/android/content/Context.html#startService(android.content.Intent)
- Android WorkManager:
  https://developer.android.com/reference/androidx/work/WorkManager.html

## Narrow supported correction

Keep the app-owned network-constrained `CoroutineWorker`, but do not start a
second Android service. The Worker already owns the OS execution window and
uses only public React Native 0.86.3 APIs:

1. Read the durable SQLite wake generation passed to the Worker.
2. Start/reuse the application's public `ReactHost`.
3. Invoke the registered `MainaPipelineWake` task through public
   `HeadlessJsTaskContext` on the UI thread.
4. Await the existing native completion token in the Worker for at most 120
   seconds.
5. The JS task claims the sole `pipeline_wake_state` row, runs the existing
   shared TypeScript recovery cycle, and completes the native token exactly
   once.
6. A timeout/failure returns `Result.retry()`; no packet/source/auth logic is
   copied into native code.

This adds no restricted permission, exact alarm, second outbox, second JS
engine, Expo-private class, foreground service, backend contract, or new data
store.

## Unique-work policy correction

`KEEP` can lose the immediate follow-up wake when a new connectivity epoch is
committed while the existing unique Worker is still running: WorkManager
rejects the new enqueue and the running Worker may already have completed its
SQLite claim. The durable row remains safe, but only startup/periodic repair
would recover it later.

Use public `APPEND_OR_REPLACE` for the versioned unique chain. Extra native
signals may append a Worker, but the SQLite claim permits one effective drain;
the appended Worker becomes a no-op when nothing is pending. Failed/cancelled
chains are replaced. This keeps scheduling responsive without bypassing cloud
backoff or creating duplicate packet/source operations.

## Evidence already obtained

- React Native version resolved: 0.86.3.
- Android module compilation passes with the direct public API bridge.
- Focused native call-policy and pipeline-wake policy tests pass.
- TypeScript typecheck passes.
- 53 focused shared tests pass.
- Exact authorized Wi-Fi Pixel target resolves to hardware serial
  `47011FDAP000VE`, Pixel 9 Pro; no USB dependency remains in the active
  toolchain checks.
- No APK was built or installed and no device/app data was changed.

Compilation is not claimed as the required runtime proof.

## Required phase-order decision

Approve both of the following before implementation resumes:

1. Replace the service-start design and `KEEP` policy with the direct public
   ReactHost/HeadlessJsTaskContext bridge plus `APPEND_OR_REPLACE` and the sole
   SQLite claim described above.
2. Build and review the unsigned/signed artifacts after all static/focused
   gates, then perform the mandatory Worker -> Headless JS -> shared TS ->
   Worker completion proof immediately after the separately approved
   data-preserving in-place install. Artifact creation is not promotion; a
   failed physical bridge proof remains an unconditional NO-GO and rollback.

Alternative: explicitly authorize installation of an isolated disposable test
package before release artifacts. Without one of these two proof-order changes,
the pre-artifact runtime gate is mechanically impossible.

## Rollback and preserved boundaries

- Remove the app-owned Worker/native bridge and retain the existing Expo
  periodic/foreground safety paths.
- The additive SQLite wake row and retry fields can remain ignored by older
  code; no meeting/audio/transcript/source row is deleted.
- No device install, uninstall, data clear, recording deletion, backend/web
  change, or external-HDD write is part of this amendment.

## Go / no-go

- **Current:** NO-GO for further product implementation and artifact build
  pending approval of this amendment.
- **After approval:** continue focused implementation/static gates, produce
  held artifacts, then run the physical bridge proof only after explicit
  install approval.
- **Hard failure:** if the direct public bridge does not start JS and return
  completion after process death on the exact Pixel, stop promotion and remove
  it; do not fall back to Expo internals or a new foreground service.
