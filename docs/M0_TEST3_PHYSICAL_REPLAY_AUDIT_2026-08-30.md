# M0 Test 3 physical replay audit — 2026-08-30

## Scope and safety

- Physical devices: Pixel 9 Pro `47011FDAP000VE` and iPhone 15
  `00008120-001E146611E2601E`.
- Installed candidates: Android `0.10.34 (60)` and iOS `0.10.34 (16)`.
- No uninstall, data clear, database reset, recording deletion, app rebuild, or
  product-code change was performed.
- Local evidence root (not committed):
  `.artifacts/m0-replay/20260830-080510-test3-call-interruption`.

## Verdict

**Test 3 remains FAILED / AT RISK.** iOS did not resume capture unattended
after either the answered-call or rejected-call path. Foregrounding Maina
caused native recovery to begin. Android retained materially more audio and
continued after the call interval, but the exact answered/rejected pair was not
fully captured by the armed system logs, so Android remains physically open
rather than being promoted on inference.

## Physical evidence

### iPhone 15

- The system delivered `AVAudioSessionInterruptionNotification` at
  `08:05:15`, and Maina changed its visible/native state to `paused` by
  `08:05:16`.
- For both the answered and rejected call paths, the owner waited while the
  phone remained locked. Capture did not resume.
- Opening Maina triggered recovery. The lock-screen microphone indicator then
  returned; screenshots were captured after each foreground-triggered resume.
- Final meeting identity remained one meeting beginning at `08:04`; no
  duplicate was visible.
- Final duration was `2:00 recorded / 6:27 elapsed`. The `4:27` difference is
  not a cosmetic timer issue: it is omitted capture time while Maina remained
  paused after interruptions.
- Local transcription, cloud notes generation, and rendering subsequently
  completed automatically for the retained two minutes. The generated notes
  correctly reflected that foregrounding the app changed it from paused to
  recording.
- No call-side audio was identified in the retained output. That is expected
  because capture was paused, but the excessive post-call pause is a P0 loss.

### Pixel 9 Pro

- Android's microphone foreground service remained active throughout every
  armed snapshot.
- System logs captured an incoming WhatsApp Business call from `08:05:16` to
  `08:05:22`, ending rejected. The owner also performed an answered path, but
  it occurred outside the complete armed call-transition interval and cannot
  be independently labeled from system logs.
- Final meeting identity remained one meeting beginning at `08:04`; no
  duplicate was visible.
- Final duration was `5:51 recorded / 6:18 elapsed`, a bounded `0:27` excluded
  interval consistent with pausing around communication rather than recording
  the call.
- The transcript contained post-call speech through `08:09`, proving capture
  continuity after the interruption period.
- The first ASR result retained 20 blocks at 96% recorded-audio coverage and
  kept the audio for bounded recovery. Permanent cloud sync was correctly held
  until recoverable windows finish.

## Root causes and connected defects

### 1. iOS recovery has no independent wake after interruption begin

`MainaIOSNativeAudioCapture.handleInterruption(.began)` closes the active WAV,
sets `paused/interrupted`, and then waits. It schedules recovery only when one
of these later signals arrives:

- `AVAudioSession` interruption-ended;
- a route-change notification; or
- `UIApplication.didBecomeActive`.

In this replay, WhatsApp did not produce a usable end/route wake while Maina
was backgrounded. The recovery background task is created only inside
`scheduleRecovery`, so it was never started at interruption begin. Foreground
activation therefore became the first usable recovery signal. This exactly
matches the physical behavior and the `4:27` recording loss.

Required correction: begin a bounded native recovery-watch task at interruption
begin, probe audio-session availability without React Native, resume the same
meeting/chunk sequence as soon as the microphone becomes available, and retain
foreground recovery only as a final fallback. The loop must stop on deliberate
pause/stop and remain bounded by iOS background execution rules.

### 2. Android partial-ASR events collapse delayed retries

Android's native policy intentionally spaces recovery rounds at roughly 20 and
60 minutes. However, every native post-processing state event wakes
`runPipelineRecoveryCycle()`. `reconcilePendingNativeMeetingWork()` immediately
relaunches any `transcript_partial` meeting below the terminal round count,
without checking whether its scheduled retry is due. This creates a feedback
loop that consumed the visible retry state from `1 of 3` to `3 of 3` within
minutes rather than honoring the delayed schedule.

Required correction: make the scheduled native worker/outbox the single owner
of delayed ASR retries; foreground reconciliation may import progress and wake
only due/deferred work. Add a due-time/active-owner guard and an event-storm
regression.

### 3. Android detail and Home presentation diverged

The open meeting detail still showed `Retry 1 of 3 is scheduled`, while Home
showed `Retry 3 of 3 is scheduled` from the newer persisted state. The detail
screen did not refresh on the same pipeline update.

Required correction: subscribe meeting detail to the persisted pipeline/meeting
change signal and reload only that meeting. Do not add another polling loop.

### 4. Test harness iOS process-filter logging is not durable

The first `pymobiledevice3 syslog --process-name Maina` stream ended shortly
after the call moved Maina out of the foreground even though the app process
survived. Screenshots and native system events remain valid, but the harness
must restart the filtered stream or capture a bounded bundle/subsystem filter
so post-call evidence is not silently absent.

## What passed

- Both devices preserved one meeting identity and durable audio already written.
- Neither device produced a duplicate meeting during interruption handling.
- Both normal stop/save paths entered local transcription.
- iOS completed local transcription, server-mediated notes, and rendered notes
  for retained audio.
- Android preserved post-call speech, exposed truthful recorded versus elapsed
  duration, retained failed-window audio, and showed coverage rather than
  discarding the meeting.
- No product code, MKC contract, provider/prompt ownership, or app data changed.

## Gates before freeze

1. Run Test 5 on both current candidates before combining corrections.
2. Bundle iOS call-resume, Android retry-ownership, post-sync/detail convergence,
   and any Test 5 defect into one data-preserving rebuild cycle.
3. Replay Test 3 answered and rejected calls on both devices with explicit
   before/after markers and no foregrounding or Retry action.
4. Require automatic native resume, consistent timer/state controls, excluded
   call audio, post-call marker presence, one meeting identity, terminal notes
   and exactly-once source sync.

