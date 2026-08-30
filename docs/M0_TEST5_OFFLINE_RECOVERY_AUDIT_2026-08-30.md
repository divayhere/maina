# M0 Test 5 — Offline recovery audit (2026-08-30)

> Historical candidate note: this document is evidence for Android `0.10.33
> (59)` and iOS `0.10.33 (15)` only. It must not be used as evidence for the
> later `0.10.34` candidates. The separate, current-run addendum is
> `M0_TEST5_OFFLINE_RECOVERY_0_10_34_ADDENDUM_2026-08-30.md`.

Status: **FAILED / AT RISK for unattended recovery.** Local recording and transcript durability passed. This is not release-readiness evidence.

## Qualified devices and installed candidates

- Android Pixel 9 Pro: Maina `0.10.33 (59)`, package `com.divay.maina`.
- iPhone 15: Maina `0.10.33 (15)`, bundle `com.divay.maina.staging`, iOS `26.6.1`.
- Both installs and all retained app data were preserved. No uninstall, data clear, database reset, recording deletion, or full iPhone-container copy was performed.

## Test sequence

1. Both devices recorded while offline.
2. Both recordings were stopped and saved while still offline.
3. Devices remained backgrounded/locked while local ASR progressed.
4. Connectivity was restored without opening Maina.
5. Android experienced one deliberate network flap during recovery.
6. No Retry button was tapped. Foregrounding was used only after the unattended acceptance gate had already failed, to verify recoverability and eventual convergence.

## Factual results

### Android

- Local ASR completed `16/16` windows with zero failed windows while locked.
- Completed audio cleanup ran and cloud notes were durably queued offline.
- Connectivity restoration woke the durable pipeline and created one notes job.
- The background client did not continue polling the job to terminal state.
- Foregrounding Maina caused the existing job to resume; immutable source ingestion returned HTTP `201` once.
- The open meeting detail remained stale and still claimed local-only/manual work after the database had synced.
- Navigating Home and reopening the same detail displayed `Notes ready` and `Synced to cloud`.
- Finding: persisted state converged correctly; the contradiction was stale presentation, not database divergence.

### iPhone

- Local ASR checkpointed `9/14` windows before the process assertion expired.
- iOS logged that a UIKit background task remained open after its expiration handler, creating termination risk.
- Restoring connectivity did not wake or continue ASR while Maina remained suspended.
- Foregrounding the existing process resumed from the durable checkpoint, not from zero.
- Final state: `14/14` windows, zero failures, notes ready, one immutable source synced, all six pipeline stages ready.
- Final source-key fingerprint (SHA-256 only): `475b8eeb519df14ac11e403a53084cd7d19940b5fac21b278a3f2f6bff961eb8`.

## Root causes established from source and logs

1. Shared packet scheduling explicitly returned no poll delay while the React Native app state was backgrounded.
2. The OS background worker returned before fire-and-forget packet/source operations reached terminal state.
3. iOS reused one fixed continued-processing request identifier instead of identifying each user-started transcription job; its submission result was discarded, hiding whether the OS accepted it or Maina fell back.
4. The iOS UIKit fallback ended asynchronously from its expiration handler, violating the requirement to balance/end the task before the handler returns.
5. Meeting detail observed AppState/focus and a narrow pending-state timer, but did not subscribe to source-sync state changes. A terminal DB transition could therefore leave the already-open screen stale.

## Required correction and replay gate

- Use a unique iOS continued-processing request per meeting and log the sanitized accepted/fallback mode.
- End every UIKit background assertion synchronously on expiration and preserve the current per-window checkpoint.
- Keep active packet polling bounded but alive while background execution is actually available.
- Await durable packet/source drains inside OS background work instead of launching detached promises.
- Emit and consume meeting pipeline state-change signals so an open detail screen converges after sync.
- Add focused tests for background polling, idempotent network flap recovery, background drain completion, and post-sync detail refresh.
- Bundle these changes with the pending iOS call-resume correction in one data-preserving Android/iOS build-install cycle.
- Repeat physical Test 3 and Test 5. Do not promote or claim readiness until both pass without foreground tricks, Retry taps, duplicates, or data loss.

## Local evidence boundary

Targeted screenshots, device logs, and SQLite snapshots remain in local qualification artifacts. They may include private transcript/device data and must not be committed to Git or shared coordination. This document contains only sanitized outcomes.
