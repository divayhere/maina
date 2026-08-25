# Week-Ready Reliability Pack checklist

Date: 25 August 2026
Target: Pixel 9 Pro personal beta
Scope: reliable capture, recoverable local ASR, truthful status, retention, and
automatic local-to-cloud handoff. This does not change any MKC API contract.

## Release scope and evidence plan

| Item | Design boundary | Acceptance evidence |
| --- | --- | --- |
| Durable stages | `meeting_pipeline_stages` is independent from the meeting summary and cloud fields. | Each stage persists status, attempt, timestamps, error, and units. |
| Resumable ASR | Native outbox owns deterministic window completion; Expo imports idempotently. | Resume begins at first unfinished window and retains completed blocks. |
| Bounded Qwen | Native Qwen adapter owns model limits and split-on-suspicion retry. | 15s/2s windows, 512/128 bounds, two threads, Kotlin tests. |
| Process containment | Capture is microphone FGS; ASR is `:asr` media-processing FGS. | Native compilation, manifest check, service timeout/defer path. |
| Audio lifecycle | Retention controller observes all Maina folders and terminal states. | Active audio protected; finished transcript audio removed; recovery audio is bounded. |
| Truthful UX | UI reads persisted window counts and the capture PCM level. | No fabricated percent or live-transcript promise. |
| Automatic post-stop | Import queues local summary; source sync uses frozen bytes. | Summary/MKC failures do not alter transcript or capture state. |
| Preserve essentials | Clicker and audio-route handling remain native and local-first. | Existing remote/capture recovery tests plus Pixel qualification. |

## Platform constraints deliberately retained

- Android recording remains a `microphone` foreground service.
- ASR remains a `mediaProcessing` foreground service in a private process. On
  Android 15+ its background budget is finite; Maina must checkpoint and defer
  when Android calls the timeout rather than trying to evade it.
- WorkManager is a durable recovery scheduler, not a promise of immediate
  background ASR. A user force-stop prevents services and jobs until Maina is
  opened again.
- A microphone route switch is allowed a bounded gap of up to three seconds;
  it must not terminate the meeting or create a new meeting.

## Non-APK quality gates

1. Coordination validator.
2. Native source and Sherpa AAR integrity validator.
3. TypeScript typecheck, unit suite, lint, dependency compatibility.
4. Expo Android regeneration and app.json/manifest parity.
5. Native Kotlin unit tests, compilation, CMake/codegen generation and merged
   Sherpa JNI verification for arm64.
6. Diff/secret hygiene review and a race/lifecycle review of changed code.

## Pixel qualification after an approved APK

1. 30-minute locked-screen capture with the clicker.
2. Switch phone → USB/Bluetooth → phone input; confirm one meeting and a
   bounded audio gap.
3. Stop via clicker; confirm persisted `Processing audio X of Y` advances.
4. Interrupt ASR, reopen Maina, confirm only unfinished windows resume.
5. Verify transcript → automatic summary → one frozen MKC source.
6. Test bad network/auth; ensure local transcript remains intact and a later
   valid retry does not duplicate the source.
7. Run a two-hour charging soak, then inspect audio cleanup, memory, thermal,
   and service diagnostics.
