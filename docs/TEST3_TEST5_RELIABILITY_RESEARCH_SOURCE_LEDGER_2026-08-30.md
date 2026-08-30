# Test 3 / Test 5 reliability research source ledger

Date: 2026-08-30

| Claim | Evidence/source | Aptness | Confidence |
| --- | --- | --- | --- |
| iOS locked Test 5 stalled at 4/14 and resumed 4->14 on foreground | Targeted SQLite snapshots and `maina-last-log.txt` in local Test 5 evidence | Direct physical evidence on iPhone 15, build 0.10.34 (16) | Very high |
| Android Test 5 completed 14/14 locally but did not finish notes/sync unattended | Paired screenshots, recovered logcat and current-run addendum | Direct physical evidence on Pixel, build 0.10.34 (60) | High |
| iOS worker detaches Qwen promise | `src/services/meetingCaptureLifecycle.ts`, `src/services/backgroundPipeline.ts` | Direct source-control proof | Very high |
| iOS registers wildcard while submitting concrete identifier | `modules/maina-recorder/ios/MainaIOSContinuedProcessing.swift` | Direct source proof; attach outcome still needs instrumentation | High |
| Concrete continued-processing task can continue after backgrounding and must report progress/handle expiration | [Apple BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask), [long-running task guide](https://developer.apple.com/documentation/BackgroundTasks/performing-long-running-tasks-on-ios-and-ipados) | First-party platform contract | High |
| Wildcard is the permitted base; submitted job uses a composed identifier | [Apple request initializer](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest/init%28identifier%3Atitle%3Asubtitle%3A%29) | First-party API documentation | High |
| Exact registration/submission can expose silent failures; newer completion API improves propagation | [Apple DTS forum](https://developer.apple.com/forums/thread/807370) | Apple staff guidance; anecdotal, not normative API contract | Medium-high |
| Interruption delivery may be delayed until a suspended app runs again | [Apple interruption notification](https://developer.apple.com/documentation/avfaudio/avaudiosession/interruptionnotification) | First-party explanation matching Test 3 | Very high |
| `CXCallObserver` reports call changes but does not promise suspended-app wake | [Apple CallKit](https://developer.apple.com/documentation/callkit), [delegate callback](https://developer.apple.com/documentation/callkit/cxcallobserverdelegate/callobserver%28_%3Acallchanged%3A%29) | First-party scope; absence of wake contract informs limit | Medium-high |
| Audio recording intents require a Live Activity | [Apple AudioRecordingIntent](https://developer.apple.com/documentation/appintents/audiorecordingintent) | First-party product/API rule | High |
| Locked Live Activity controls require authentication/unlock | [Apple interactive Live Activities](https://developer.apple.com/documentation/widgetkit/adding-interactivity-to-widgets-and-live-activities) | First-party UX/security limit | High |
| Android reconnect filtered out retryable work by future due time | `src/app/_layout.tsx`, `src/services/meetingPacket.ts`, `src/data/meetings.ts` and device logs | Direct source and physical correlation | Very high |
| `KEEP` ignores a new unique work request; `APPEND_OR_REPLACE` runs despite failed/cancelled prerequisite | [Android managing work](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/manage-work) | First-party WorkManager policy; relevant to ASR worker/harness audits, not the direct Test 5 packet cause | High |
| WorkManager is the reliable persistent Android queue with constraints and backoff | [Android persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent) | First-party architecture guidance | High |
| Offline queues should drain on connectivity with persistent, idempotent work | [Android offline-first guide](https://developer.android.com/topic/architecture/data-layer/offline-first) | First-party architecture directly analogous to Maina packet/source outboxes | High |
| Expo periodic tasks are discretionary; Android minimum interval is 15 minutes and iOS is system-decided | [Expo BackgroundTask](https://docs.expo.dev/versions/latest/sdk/background-task/) | Official framework behavior | High |

## Evidence hygiene

- Local artifacts contain screenshots, logs, DB snapshots and private transcript
  content. They remain uncommitted.
- Git documents contain only sanitized meeting IDs, source-key fingerprints,
  versions, timings, counters, states and status codes.
- No credentials, tokens, provider keys, transcript bodies, private URLs or
  customer content are recorded here.

