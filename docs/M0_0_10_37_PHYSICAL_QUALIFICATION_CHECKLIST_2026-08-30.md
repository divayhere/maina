# Maina 0.10.37 physical qualification checklist

Date: 2026-08-30 (Asia/Kolkata)

Status: **ACTIVE CHECKLIST — APPS NOT READY**

This supersedes M0_MORNING_PHYSICAL_REPLAY_CHECKLIST_2026-08-30.md for
installed 0.10.37. The older 0.10.34/schema-15 checklist is historical and
must not be executed as written.

## Frozen candidate identity

| Item | Android | iOS |
| --- | --- | --- |
| Installed app | 0.10.37 (63) | 0.10.37 (19) |
| Installed schema | 16 | 16 |
| Artifact source | f88b2d0b563db691fead0ed781a53acec3eafc8e | eb903c56b0a8caedd140e5a556cb89454e1916f7 |
| Device | Pixel 9 Pro, 47011FDAP000VE | iPhone 15, CoreDevice 945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD |

- Coordination: 4f4134db534f877893e2fff48244cb9fbaed02e4 or a verified
  documentation-only successor.
- Frozen Backend/Web inputs remain unchanged.
- iOS Personal Team profile expires 2026-09-03 00:40:10 IST.
- Never uninstall, clear data, reset SQLite, delete retained owner recordings,
  or install rejected 0.10.36 artifacts.

## Current hold

The first safe 0.10.37 replay reproduced an Android navigation failure:

~~~text
To-dos -> Notifications bell -> native system Back
expected: To-dos
observed: Home
~~~

The replay stopped there. iOS navigation, cleanup/duration and resource
endurance were not continued. No product code, build or install followed.

Evidence:
/Users/divay/Developer/Maina/qualification/2026-08-30-0.10.37-post-install/

The bounded root-cause analysis and correction recommendation are recorded in
`SAFE_GATE_REPORT.md` in that directory. The installed candidate remains held;
the report recommends moving the proven hidden-secondary route family from
Tabs to the existing outer native Stack, subject to review before any product
edit.

## Gate A — navigation and local-only refresh

Acceptance:

- iOS left-edge swipe right and visible Back are native Back.
- Android system Back and visible Back follow the same meaningful history.
- Home -> meeting -> Back returns Home.
- To-dos -> source meeting -> Back returns To-dos.
- Notifications -> meeting -> Back returns Notifications.
- Opening Notifications itself returns to the valid screen that opened it.
- Save -> new meeting -> Back returns Home, never an older meeting.
- Recovery/delete cannot expose stale or deleted routes.
- Orphan, reload and deep-link fallback is Home.
- There is no custom right-to-left forward swipe.
- Refresh works only at scroll top and reloads local SQLite/store state.
- Refresh creates zero Qwen windows, jobs, sources, retry changes or wake
  generations.

Current Android:

- Home refresh: PASS; 34 recordings before/after, identical screen state.
- Home -> meeting -> Notes/To-dos/Transcript -> system Back: PASS.
- Home -> meeting -> header Back: PASS.
- To-dos -> source meeting -> system Back: PASS.
- Notifications refresh: PASS; remained All clear.
- To-dos -> Notifications -> system Back: **FAIL; returned Home**.
- SQLite-lock/pipeline-reconciliation warning in this replay: not observed.
- Connectivity-reconciliation warning in this replay: not observed.

Current iOS: NOT RUN after the Android failure under stop-on-failure policy.

## Gate B — owner Test 3 call interruption

Run only after the current hold is resolved or explicitly waived. Run every
case independently on both devices and retain one meeting identity per case.

### B1. Rejected call

1. Start a recording and say “before rejected call”.
2. Lock the phone.
3. Place and reject an ordinary phone/WhatsApp call.
4. Do not open Maina or tap Resume.
5. Say “after rejected call”, stop normally and allow terminal processing.

### B2. Short answered call

1. Start a fresh recording and say “before short answered call”.
2. Lock, answer for 20–30 seconds, then end the call.
3. Do not foreground Maina or tap Resume.
4. Say “after short answered call”, stop and finish processing.

### B3. Two-minute answered locked call

1. Start a fresh recording and say “before two minute locked call”.
2. Lock, answer and keep the call active for at least two minutes.
3. End it while still locked. Do not foreground Maina or tap Resume.
4. Say “after two minute locked call”, stop and finish processing.

### B4. Manual-pause ownership

1. Deliberately Pause a fresh recording.
2. Place and end/reject a call.
3. Confirm system callbacks do not resume the manual pause.
4. Resume deliberately, record a marker and stop.

### B5. Stop cancellation

1. During pending interruption recovery, use normal Stop/Save.
2. Confirm no later callback restarts capture or creates another chunk.

Each case passes only with one meeting ID, a finalized pre-call chunk, a new
monotonic post-call chunk after audio ownership returns, zero call-interval
text, both markers, truthful timer/label/button/native state, no manual-pause
override, no post-Stop restart and terminal pipeline completion without
duplicates or loss.

## Gate C — owner Test 5 offline recovery

Run three locked runs per device. Each must converge within 30 minutes of
stable connectivity. The owner performs only deliberate network changes;
Maina must recover without foregrounding or Retry.

### C1. Process alive

1. Disable internet.
2. Record and stop one short qualification meeting offline.
3. Lock the phone and restore internet.
4. Do not open Maina or tap Retry.

### C2. Process death

1. Repeat offline capture.
2. Use the approved process-death action after durable local save.
3. Restore internet while locked; do not foreground Maina or tap Retry.

### C3. One network flap

1. Repeat offline capture and restore internet while locked.
2. Disconnect once briefly during recovery, then restore stable connectivity.
3. Do not foreground Maina or tap Retry.

Every run passes only with durable transcript/audio/outbox state, one effective
connectivity epoch, one created job or one poll of the same job, stable job ID,
packet hash and source key, one canonical source, due-time-gated provider
backoff, UI convergence without relaunch, safe user copy, Android
connectivity-warning correlation and completion within 30 minutes.

## Gate D — cleanup and duration truth

Use only fresh or explicitly disposable qualification data. Never delete owner
recordings merely to satisfy this gate.

- Eligible terminal audio directory and DB pointer clear within 60 seconds and
  remain correct after relaunch.
- Deletion failure retains pointer and retry state.
- Partial/recoverable audio remains under retention policy.
- Duration comes from native WAV/chunk measurements; interruption gap is
  separate.
- Reload/process death cannot replace measured duration with wall time or zero.
- Android fallback retention scans remain coalesced.

Status: NOT RUN in this stopped replay.

## Gate E — bounded iOS release resource endurance

Use the installed signed iPhone 15 build and an approved qualification input.
Do not create an unbounded capture.

- First run: at least 60 minutes or 120 Qwen windows.
- Second run: 30 minutes.
- Stop for stalled windows, app/OS termination, jetsam/watchdog, cpu_resource
  termination action, uncontrolled growth, thermal/storage danger or lost
  checkpoint responsiveness.
- No jetsam/watchdog/CPU-resource termination action or stalled window.
- After warm-up, three 10-window rolling peaks must not rise monotonically by
  more than 10% per bucket.
- Within two minutes of recognizer release, footprint returns within 20% of
  the pre-ASR post-model baseline or within 300 MB, whichever is larger.
- Second run starts no more than 10% above the first post-release baseline.

Status: NOT RUN in this stopped replay.

## Capacity and readiness

The old fixed 20/25 GiB gates are retired. Capacity uses measured free space,
active build/evidence growth, remaining intermediates, reusable caches,
artifact/log staging and filesystem volatility. Stop only for an official tool
requirement, probable/actual ENOSPC, uncontrolled growth or inability to finish
safely.

Any mandatory miss keeps Apps **NOT READY**. Automated checks cannot replace
locked physical Test 3/Test 5 or iOS resource qualification.
