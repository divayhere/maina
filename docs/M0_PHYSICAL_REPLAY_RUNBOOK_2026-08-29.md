# M0 physical replay runbook — final-build evidence

This closes the two evidence gaps recorded in the 2026-08-29 dual-device report. It never installs, uninstalls, clears app data, launches with `--terminate-existing`, or changes MKC contracts.

## Controller preflight

```bash
bash scripts/m0-replay-harness.sh preflight
```

The harness fails unless the exact Pixel and the exact iPhone 15 are connected and both Maina package identities are installed. Evidence stays under ignored `.artifacts/m0-replay/`.

## Test 3 — call interruption

Arm with:

```bash
bash scripts/m0-replay-harness.sh arm test3-call-interruption
```

Minimum owner actions:

1. Start one recording on each phone while ordinary speech or a podcast continues.
2. Call the iPhone 15, answer for 20–30 seconds, then hang up. Repeat once by rejecting the call.
3. Call the Pixel, answer for 20–30 seconds, then hang up. Repeat once by rejecting the call.
4. Stop and save both recordings normally after at least another minute.
5. Unlock a phone only if the OS requires it.

Pass evidence: each call creates a system pause, the call interval is excluded,
manual pause never auto-resumes, and both meetings finish their durable pipelines
without duplicate IDs. Android must resume the same meeting unattended after the
exact retained recorder becomes unsilenced. On iOS, rejected and short calls must
resume within the measured bounded recovery window while execution remains
available; an answered locked call must preserve all pre-call audio and resume the
same meeting on the first public OS-permitted wake. Do not claim a blanket
five-second zero-touch iOS pass when the OS suspended Maina.

## Test 5 — offline-to-cloud recovery

Arm with:

```bash
bash scripts/m0-replay-harness.sh arm test5-offline-recovery
```

Minimum owner actions:

1. Enable airplane mode on both phones, then re-enable Bluetooth only if the test microphone needs it.
2. Record and stop a 2–3 minute meeting on each phone while offline.
3. Wait until the local transcript reaches a durable terminal state.
4. Disable airplane mode on both phones. Do not tap retry, reopen a meeting, or relaunch Maina.
5. Unlock a phone only if the OS requires it.

Pass evidence: connectivity restoration wakes the existing notes job and immutable source sync exactly once, no duplicate meeting packet/source is created, temporary network failures remain retryable, and the UI never exposes a hostname or stack trace.

## Evidence snapshots and close

```bash
bash scripts/m0-replay-harness.sh snapshot before-user-action
bash scripts/m0-replay-harness.sh snapshot after-user-action
bash scripts/m0-replay-harness.sh stop
```

The controller then correlates local logs, app state, transcript coverage, job identity, source identity, and sanitized MKC status. Test 3 and Test 5 remain open until both exact physical replays pass on the final installed builds.
