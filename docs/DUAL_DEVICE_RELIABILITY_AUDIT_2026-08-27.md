# Maina dual-device reliability audit — 2026-08-27

Status: completed device/pipeline pass. This document records measured evidence from the Android Pixel and USB-connected iPhone 15. The two clients reached different terminal outcomes, so the release verdict is intentionally not a blanket pass.

## Scope and acceptance bar

The primary requirement is durable, uninterrupted capture for real meetings lasting one to three hours. The second requirement is eventual, autonomous local transcription. Cloud notes and MKC synchronization must follow only after a durable complete transcript and must never downgrade a locally successful recording.

The audit separates four kinds of evidence:

1. Native recording evidence: process/session continuity, finalized WAV files, duration, route transitions, and capture gaps.
2. Local ASR evidence: persisted window counters, failed intervals, transcript blocks, process-death recovery, screen-off continuation, memory, and thermal behavior.
3. Cloud evidence: one stable meeting-packet job, truthful polling, returned packet persistence, immutable source sync, and retry/revocation behavior.
4. UI evidence: visible progress and terminal states checked against the underlying database and native logs.

## Test under audit

- Android: Pixel 9 Pro, Maina 0.10.29 (55).
- iOS: USB-connected iPhone 15 only, Maina staging 0.10.26 (9).
- Both recorded the same long-form playback beginning at approximately 16:45 IST.
- Android stopped cleanly after 2:20:05.
- iOS was intentionally terminated after more than 2:24 to test crash recovery. Relaunch recovered and finalized all 15 WAV chunks into the same meeting.

## Confirmed recording evidence

### Android

- One native recorder session remained active for the full 2:20 test.
- Format remained 16 kHz, mono, `VOICE_RECOGNITION`, built-in microphone.
- The recorder was not reported as silenced.
- No route restart or material capture discontinuity was recorded.
- Capture memory remained approximately 171 MB PSS and the charged device remained thermally usable.

Assessment: strong evidence for the tested Pixel capture path. This does not yet prove every OEM, Bluetooth route, call interruption, or three-hour session.

### iOS

- The native recorder produced 15 sequential WAV chunks for a 2:24:19 session.
- The first 14 chunks were approximately ten minutes each; the recovered final chunk contained the remaining audio.
- Native metrics report 15/15 finalized chunks, approximately 8,658,644 ms of audio, zero material capture gap, and one restart/recovery event.
- Sampled PCM from early and mid-session chunks was non-silent.
- After deliberate process termination, relaunch recovered the partial chunk and continued from the same meeting rather than losing the recording.

Assessment: strong evidence that durable chunked capture and partial-WAV recovery work on the tested iPhone 15. A TestFlight/release build and true iOS memory-pressure termination remain separate gates.

## Confirmed transcription evidence

### Android

- Native foreground post-processing uses a durable native outbox and per-window checkpoint.
- At forced process termination, progress was 86/645 windows.
- Relaunch eventually resumed from exactly 86 rather than recomputing completed work.
- The observed resume delay was approximately two to three minutes because an old heartbeat is considered active for 120 seconds.
- The first pass reached 644/645. One voice-bearing 15-second interval (chunk 1, window 42, 546000–561000 ms within that chunk) repeatedly returned blank from Qwen after bounded low-energy splitting.
- The immediate retry reused the native manifest: it skipped the 644 completed windows and retried only the failed interval. The interval failed again with `Confirmed voice returned no text during local transcription.`
- The app preserved 644 transcript blocks and retained the audio. It did not create an MKC meeting-packet job and did not sync an incomplete immutable source. Production D1 returned no packet/source rows for `meeting:maina:mtbfeoig-2wbe3r`.
- More than five minutes after the immediate retry, Android's job scheduler exposed no `MainaPostProcessingRecoveryWorker` job. A controlled app-process relaunch also did not retry because foreground reconciliation currently retries a partial meeting only when checked-window count is below total; 644 completed plus one failed equals the full 645.

Finding A1 — process-death recovery is durable but not immediately responsive. Foreground reconciliation should reclaim a dead run immediately when the owning process/service no longer exists, rather than relying only on heartbeat age.

Finding A2 — autonomous recovery has a scheduling hole after a terminal partial pass. The immediate retry is efficient, but the documented four scheduled rounds did not appear in JobScheduler, and foreground relaunch excludes a fully checked partial manifest. The most likely scheduler cause is the service calling `enqueueUniqueWork(..., KEEP, ...)` while the same uniquely named worker that launched it can still be pending: Android documents that `KEEP` ignores the new work in that case. The only visible continuation is manual `Re-transcribe from saved audio`. This fails the low-intervention requirement and must be proven with a worker-state regression test rather than fixed by assumption alone.

Finding A3 — one unrecoverable interval currently blocks the entire notes/source pipeline forever even though 99.84% of windows and a substantial transcript are durable. Safety is correct—no incomplete immutable source was silently published—but product policy needs a bounded terminal-partial path with explicit coverage evidence rather than an indefinite trap.

### iOS

- Local Qwen continued processing for more than 20 minutes while the display was asleep. Persisted SQLite counters increased while the screen remained black.
- At forced process termination, progress was 48/664 windows with 48 transcript blocks.
- Relaunch reset progress to 2/664 and rebuilt the transcript from the beginning.
- The resumed pass reached 664/664, zero failed windows, 26,945 words, and 630 durable transcript blocks.
- A live integrity query at 428 persisted blocks found zero non-monotonic starts, zero exact adjacent duplicate blocks, and zero empty blocks. This is evidence that the current uninterrupted pass is appending ordered output rather than visibly duplicating overlapping windows.
- MKC created exactly one packet job, completed all 5/5 sections through Google `gemini-3.6-flash` in approximately 69 seconds, and returned a structured packet. A controlled app relaunch was then required before the client noticed the already-ready job, stored the notes, and synced immutable source `meeting:maina:mtbfen8e-bwh6my`.
- Production D1 independently confirmed the immutable meeting source exists and is not deleted.
- Completed audio remained after packet/source completion until another startup retention reconciliation. That relaunch removed the physical recording directory and cleared the audio pointer while preserving transcript and notes.

Finding I1 — audio is durable, but iOS ASR progress is not. The current JavaScript fallback calls `resetTranscript: true` and has no durable per-window manifest. A second process death late in a long job can waste nearly all completed inference and repeatedly delay completion.

Finding I2 — the iOS stage table can report `queued` while meeting-level counters are actively advancing. The visible meeting counter is currently more truthful than the stage record, but the two representations must be made atomic/coherent.

Measured example: while meeting-level progress exceeded 400/664, the `asr` stage still held `queued`, attempt 2, 0/0, last updated at 19:17:18. This is a real state-contract defect, not merely stale screen rendering.

Finding I3 — packet polling has a liveness hole. A job created after the startup poll scheduler has gone idle is requested once but does not wake the bounded poll loop. The server finished normally; the phone stayed at `summarizing/running/local_only` until relaunch reconciled the existing job. No duplicate job was created.

Finding I4 — terminal audio cleanup is correct but not promptly triggered. It currently depends on a later startup/retention pass instead of running immediately after transcript/packet/source terminal state.

## Resource evidence

- Android native Qwen process reached approximately 2.0 GB PSS during the long run.
- iOS Maina reached approximately 2.0 GB physical footprint and generated CPU-resource diagnostic reports after sustained high CPU. iOS took no termination action during the observed period.
- Both results are acceptable evidence for the tested high-memory phones, not proof for lower-memory Android devices or all iPhones.

Finding R1 — device-tier preflight is required. Maina should not promise the same local model on phones that cannot safely sustain roughly 2 GB of ASR working memory.

## UI evidence

- Android visible progress matched native notification state and increased while the job ran.
- iOS visible progress refreshed after waking and matched the same direction as persisted SQLite. A black iPhone screenshot was the locked display, not a stopped recorder or ASR job.
- Very short/silent historical meetings can remain labelled `Transcription queued` even after all windows are checked. Aggregate `recorded` is being presented as perpetual work instead of a terminal `no speech` outcome.
- Android's same meeting used wall duration `2:20:05` on the home card and audio duration `2:20:03` on detail. The approximately two-second capture-vs-audio difference is acceptable, but the label must name one consistent duration contract rather than visibly changing between screens.
- Android's transcript tab truthfully preserved 644 blocks and exposed `Re-transcribe from saved audio`, but the fully checked progress presentation does not state `644/645` or the one missing interval. A full bar plus `Transcript needs recovery` is technically explainable but not sufficiently clear.
- iOS terminal SQLite state is internally coherent after reconciliation: all six stages (`recording`, `audio_finalized`, `asr`, `transcript_durable`, `summary`, `mkc`) are `ready`; transcript is 630 blocks/140,806 characters; audio is deleted. The screen could not be visually inspected at that checkpoint because the exact USB iPhone 15 remained locked.

Finding U1 — add a terminal no-speech/empty-audio presentation state and stop polling once every window is terminal.

Finding U2 — normalize duration semantics and show explicit partial coverage/gap status instead of pairing a full progress bar with an unexplained recovery label.

## Current release verdict

Capture passed strongly on both tested devices: Android recorded 2:20 continuously, and iOS recovered/finalized 2:24 after an intentional app termination. The recording layer is substantially more trustworthy than the post-call orchestration.

The complete product pipeline did not pass on both devices. iOS eventually completed transcription, notes, and source sync, but lost ASR progress on process death and needed relaunches to wake packet polling and completed-audio cleanup. Android preserved capture and 644/645 transcript windows, but one failed interval trapped the meeting in manual recovery and correctly prevented notes/source publication. Maina therefore must not yet be described as blindly trustworthy for unattended critical three-hour meetings.

## Prioritized corrective work

1. P0: persist iOS per-window completion and transcript blocks; resume without resetting completed work.
2. P0: wake iOS packet polling whenever a job is created or non-terminal work exists; retain one job identity across relaunch/network interruption.
3. P0: close Android's terminal-partial recovery scheduling hole; verify all bounded recovery rounds on a physical release build.
4. P0 product policy: after bounded retries, preserve the partial transcript and coverage/gap evidence, generate explicitly qualified notes, and sync through correction lineage if the missing interval is recovered later. Do not silently call partial coverage complete.
5. P0: make iOS stage state and meeting counters one coherent transaction/state machine.
6. P1: reclaim dead Android native ASR immediately on foreground/service absence; retain heartbeat as a secondary guard.
7. P1: trigger completed-audio cleanup immediately after terminal durable outcomes; retain startup retention as repair fallback.
8. P1: use iOS continued-processing support where available, with expiration checkpointing; retain durable relaunch recovery as the guarantee.
9. P1: port the Android bounded VAD/low-energy recovery policy to iOS without introducing a multi-model chain.
10. P1: add iOS media-services-reset reconstruction for rare audio-server restarts.
11. P1: terminate silent/empty meetings honestly as `No speech detected` or auto-discard them under an explicit short-recording policy.
12. Separate backend blocker: repair the repeated semantic-assignment history uniqueness retry storm. It is not caused by mobile ASR and should not be fixed in the app branch.

## Evidence locations

Local test artifacts are deliberately outside Git because they contain device diagnostics and potentially private transcript text:

- `/tmp/maina-dual-longrun-20260827-1625/`
- `/tmp/maina-crash.CLdsiv/`

Only sanitized conclusions belong in Git or shared coordination.
