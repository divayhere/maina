# M0 Test 5 — 0.10.34 offline-recovery addendum (2026-08-30)

Status: **FAILED / AT RISK for unattended recovery.** Data safety,
checkpoint resume, foreground recovery, notes generation and immutable sync
passed. Recovery while both phones stayed locked did not pass.

This is a separate physical run from
`M0_TEST5_OFFLINE_RECOVERY_AUDIT_2026-08-30.md`. Counts and conclusions from
the two candidates must not be combined.

## Exact candidate and evidence boundary

- Pixel 9 Pro `47011FDAP000VE`: Maina `0.10.34 (60)`, source implementation
  `8bb0a1c`.
- iPhone 15 `00008120-001E146611E2601E`: Maina `0.10.34 (16)`, source
  implementation `ff43a64`, iOS `26.6.1`.
- Test start: 2026-08-30 08:53 IST.
- Local evidence root (not committed):
  `.artifacts/m0-replay/20260830-085309-test5-offline-recovery`.
- Android local meeting: `mtf8v9qj-6by157`; source-key SHA-256 fingerprint
  `645c07df34babc94e7776df1fa6ddece8f33cfdedc2d67634e4fe8b0b37ae4f7`.
- iOS local meeting: `mtf8v88s-9nan7q`; source-key SHA-256 fingerprint
  `deaed32ad971818a6f5205c009479f9d19b48d226f84039bd725e35b0807c980`.
- No uninstall, data clear, DB reset, recording deletion, full-container copy,
  app rebuild, Retry tap or product-code change occurred during this audit.

## Physical sequence

1. Both phones recorded while offline.
2. Android saved 2:59; iPhone saved 3:00.
3. Both phones were locked while local ASR ran.
4. Internet was restored without opening Maina.
5. One deliberate network flap was applied during recovery.
6. Both apps remained locked long enough to prove unattended recovery had not
   converged.
7. The apps were then foregrounded only to prove checkpoint safety and eventual
   convergence.

## What happened

### Android 0.10.34 (60)

- Local Qwen transcription completed `14/14` windows with zero failures while
  locked.
- The reconnect callback and periodic background worker ran, but neither found
  a packet eligible under the persisted future retry timestamp.
- The meeting did not finish notes/sync while the app remained locked.
- After foregrounding, the existing durable work converged without a manual
  Retry tap. The final Home and detail screens showed `Notes ready` and
  `Synced to cloud`.
- Repeated paired screenshots at first foreground, convergence, +5 minutes,
  +10 minutes and final remained consistent.
- The same meeting identity remained visible; no client-side duplicate was
  observed. Independent backend retrieval uniqueness was not proved in this
  run and remains an Admin/live qualification gate.

### iOS 0.10.34 (16)

- While locked, persisted state stopped at `4/14`, zero failed windows,
  `summary_status=idle`, and `knowledge_cloud_sync_status=local_only`.
- The same `4/14` state remained after internet restoration and after the
  deliberate network flap.
- Foregrounding resumed at window index 4 rather than zero. This proves durable
  per-window checkpointing worked.
- The meeting reached `14/14`, zero failures, notes ready, and immutable sync
  HTTP `201` without a Retry tap.
- Final SQLite state was `summarized`, `summary_status=ready`,
  `knowledge_cloud_sync_status=sync_succeeded`; all six pipeline stages were
  `ready`.
- The open UI advanced live to terminal state and stayed correct across the
  repeated screenshots. A relaunch was not needed once processing had resumed.
- Completed-audio retention ran immediately after source sync and deleted one
  eligible completed audio item.

## Timed iOS persisted-state proof

| Checkpoint | Persisted state |
| --- | --- |
| Locked | `transcribing`, `4/14`, zero failed, local-only |
| Online while locked | unchanged `4/14` |
| After network flap while locked | unchanged `4/14` |
| First foreground capture | `summarized`, `14/14`, ready, synced |
| Final targeted DB copy 09:46 IST | `14/14`, all six stages ready |

The foreground log shows Qwen processing windows 4 through 13 between 09:36:33
and 09:37:37 IST, meeting-packet completion at approximately 09:38:00, and
source sync HTTP `201` at 09:38:07.

## Current-run conclusions

- **Data loss:** not observed.
- **Checkpoint resume:** passed on iOS (`4 -> 14`, not `0 -> 14`).
- **Local locked ASR:** passed on Android; failed to continue on iOS.
- **Unattended reconnect:** failed on both.
- **Foreground recovery:** passed on both.
- **Terminal UI convergence after foreground:** passed on both in this run.
- **Overall Test 5 gate:** failed / at risk.

## Separate residuals, not Test 5 failures

- Android Home still contains an older 08:04 meeting with truthful
  `Partial transcript saved` (`1 of 27` failed). It is not the 08:53 Test 5
  meeting.
- iPhone accessibility evidence exposes an older Aug 29 21:47 meeting still in
  a retryable/in-progress cloud state. It is not the 08:53 Test 5 meeting and
  should be audited separately before freeze.
- The initial background log streams terminated early because the harness did
  not persist ownership of their processes. Android ring-buffer logs and
  targeted iOS SQLite/log copies supplied the factual evidence. The harness
  must fail preflight if its monitors do not stay alive and grow.

## Release gate

Do not promote either candidate on this run. Apply the bounded correction in
`TEST3_TEST5_RELIABILITY_RESEARCH_2026-08-30.md`, run focused tests, make one
data-preserving build/install per platform, and replay physical Tests 3 and 5.

