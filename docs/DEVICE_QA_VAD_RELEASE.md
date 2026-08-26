# Maina Device QA — VAD Recovery Release

Run this only against the exact APK built from commit `7bb2dad` or a descendant.
The purpose is to qualify the complete local-first path on the connected Pixel
without treating a static compiler pass as proof of a real meeting.

## Evidence capture

For every checkpoint, save:

- an ADB screenshot;
- focused `logcat` filtered to `MainaPostProcessing`, `MainaVoiceActivity`,
  `MainaRecording`, and `Maina`;
- the resulting meeting state from the app and native outbox.

Screenshots are evidence for layout, navigation, and stale-cache errors; logs
are evidence for the audio/ASR state machine. Neither replaces the other.

## QA-01 — Launch and identity

1. Install over the existing app, preserving data.
2. Launch Maina and capture Home, To-dos, Settings, and a meeting detail.
3. Confirm package/version identity and that no red error/safe-mode state is
   shown.

Pass: the new app launches, navigation is responsive, bottom shell does not
cover content, and existing meetings remain readable.

## QA-02 — Intentional discard

1. Start a recording.
2. Wait 5–10 seconds without speaking.
3. Discard it.
4. Return Home and refresh.

Pass: no meeting card or orphaned processing item appears, and the active
recording indicator clears everywhere.

## QA-03 — Quiet/brief speech is retained

1. Start a recording.
2. Speak one quiet English/Hinglish sentence for 8–12 seconds.
3. Stop and save; remain on the processing state briefly, then visit Home and
   reopen the meeting.

Pass: the saved recording reaches a terminal transcript state. The log must
show either `uncertain` VAD + one Qwen attempt or `speech`; it must not report
`Transcript needs recovery` solely because an RMS threshold was crossed.

## QA-04 — Speech/noise transition

1. Start a 60–90 second recording with English, Hindi/Hinglish, a quiet pause,
   and normal room noise.
2. Pause once, resume once, then stop and save.
3. Observe recording screen, Home card, meeting detail, Notes, and To-dos
   while processing continues.

Pass: elapsed time is coherent, recording state propagates without stale cards,
progress increases durably, silent windows may show in logs as
`skipped_silence`, and a complete transcript unlocks notes/MKC only after the
local result is stable.

## QA-05 — Interruption and durable recovery

1. During a new 60–90 second recording or post-processing run, background the
   app, lock the screen briefly, then reopen it.
2. If processing is active, do not force-stop Maina.
3. Confirm the same meeting continues/resumes rather than creating a duplicate.

Pass: outbox state stays one run per meeting, completed/silent windows are not
redone, and unfinished windows remain `retry_pending` rather than falsely
marking the whole transcript complete.

## QA-06 — Cloud/MKC observation (only if already configured)

1. Use the completed QA-04 meeting.
2. Wait for notes generation and sync.
3. Inspect its meeting-level state.

Pass: no cloud or MKC action happens before a stable local transcript. If an
account/config is unavailable, the local transcript remains usable and the
cloud state is clearly deferred rather than presenting an error as data loss.

## Release decision

Block the release if any of the following occurs:

- a blank/noisy VAD window alone produces `Transcript needs recovery`;
- an audio file/transcript is lost on pause, resume, lock, or navigation;
- an old/stale Home or meeting state hides a running recording;
- the app crashes, loops, or UI controls overlap/obscure a required action;
- a local transcript becomes mutable or an MKC sync is attempted before it is
  terminal.

Keep the audio from any failed QA run within the existing recovery window; it
is the forensic input for the next diagnosis.
