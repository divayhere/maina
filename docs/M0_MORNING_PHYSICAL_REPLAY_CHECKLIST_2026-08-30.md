# M0 morning physical replay checklist — 2026-08-30

This checklist closes the only two remaining physical reliability gates on the
installed 0.10.34 candidates. It preserves every meeting and never uninstalls,
clears app data, resets a database, or creates a full iPhone-container copy.

## Installed candidates

- Android: Maina 0.10.34 (60), exact Pixel 9 Pro hardware serial
  `47011FDAP000VE`.
- iOS: Maina 0.10.34 (16), exact iPhone 15 serial `MQLF6GV3XM`.
- Backend contract pin: `57cbb52`.
- All Memory A-C feature flags remain default-off.

## Controller preflight

From the iOS worktree:

```bash
export PATH=/Users/divay/Library/Android/sdk/platform-tools:$PATH
bash scripts/m0-replay-harness.sh preflight
```

Do not continue unless the output names Android 0.10.34 (60) on the exact Pixel
and the iPhone 15 staging bundle. If CoreDevice remains `connecting`, leave the
apps untouched, unlock the iPhone once, reconnect its USB cable, and rerun only
the preflight.

## Test 3 — call interruption and automatic same-meeting resume

Arm evidence:

```bash
bash scripts/m0-replay-harness.sh arm test3-call-interruption
```

Owner actions:

1. Play continuous ordinary speech near both phones.
2. Start one Maina recording on each phone and speak the marker “before call.”
3. Wait one minute, then lock both phones without swiping Maina away.
4. Call the iPhone 15. Answer for 20–30 seconds, hang up, and wait 60 seconds
   without opening Maina. Continue the external speech and say “after answered
   iPhone call.”
5. Call the iPhone again and reject it. Wait 30 seconds without opening Maina.
6. Repeat the answered-call and rejected-call sequence on the Pixel.
7. Unlock each phone only after the autonomous wait. Open Maina and verify that
   the label, Resume/Pause control, and timer agree with native recording state.
8. Stop and save both recordings normally after at least one further minute.

Required pass evidence:

- Answered calls pause and then resume the same meeting without opening Maina.
- Rejected calls do not terminate the recording.
- Call audio is excluded; post-call speech is present.
- Timer, label, button, native status, and recorded duration agree.
- Normal Stop and save reaches terminal transcript, notes, and MKC sync without
  a duplicate meeting or source.

Manual pause is a separate control: deliberately pausing Maina must never be
mistaken for a call interruption and must not auto-resume.

## Test 5 — offline capture and unattended cloud recovery

Run only after Test 3 passes. Arm fresh evidence:

```bash
bash scripts/m0-replay-harness.sh arm test5-offline-recovery
```

Owner actions:

1. Put both phones in airplane mode. Re-enable only the local microphone route
   if a test microphone requires Bluetooth.
2. Without reopening a prior meeting, record two to three minutes of ordinary
   speech on both phones and stop/save while still offline.
3. Keep Maina in the background or lock the displays. Do not tap Retry, relaunch
   Maina, or open the meeting detail.
4. Allow local transcription to continue. The controller will identify the
   durable terminal transcript state from targeted evidence.
5. Restore internet from system controls without foregrounding Maina.
6. After 20 seconds, disable internet once for 30 seconds, then restore it. This
   is the single network flap.
7. Wait for the controller to confirm convergence before opening Maina.

Required pass evidence:

- Offline recording and local ASR remain durable.
- Notes and source-sync transport failures remain retryable, not terminal.
- Connectivity restoration wakes existing work with no Retry tap or app reopen.
- One idempotent recovery chain reaches notes ready and canonical source sync;
  no duplicate packet, meeting, or source is created.
- The network flap preserves retry state and later converges.
- UI changes to the persisted terminal state without navigation tricks and uses
  plain “waiting for internet” language rather than hostnames or exceptions.

## Evidence snapshots and close

At each named checkpoint:

```bash
bash scripts/m0-replay-harness.sh snapshot <checkpoint-label>
```

At the end:

```bash
bash scripts/m0-replay-harness.sh stop
```

Only sanitized counts, versions, state transitions, timestamps, retry counts,
and identity fingerprints may enter Git or shared coordination. Raw audio,
transcripts, credentials, session tokens, private URLs, and customer content
remain local and ignored.

