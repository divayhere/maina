# Maina dual-device reliability audit — source ledger

This ledger records primary sources used to assess the measured device behavior. Maina-specific conclusions still depend on physical evidence captured in the paired audit report.

## Apple

- [Performing long-running tasks on iOS and iPadOS](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados) — authoritative background-task options and limits.
- [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask) — authoritative continued user-initiated processing behavior.
- [BGContinuedProcessingTaskRequest](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtaskrequest) — authoritative request and scheduling contract.
- [Testing a release build](https://developer.apple.com/documentation/xcode/testing-a-release-build) — authoritative warning that debugger-attached behavior is not release evidence.
- [Identifying high-memory use with jetsam event reports](https://developer.apple.com/documentation/xcode/identifying-high-memory-use-with-jetsam-event-reports) — authoritative diagnosis of memory-pressure termination.
- [Reduce terminations in your app](https://developer.apple.com/documentation/xcode/reduce-terminations-in-your-app) — authoritative termination-risk guidance.
- [Reducing your app's memory use](https://developer.apple.com/documentation/xcode/reducing-your-app-s-memory-use) — authoritative memory-footprint guidance.
- [Responding to memory warnings](https://developer.apple.com/documentation/uikit/responding-to-memory-warnings) — authoritative memory-warning behavior.
- [AVAudioSession mediaServicesWereResetNotification](https://developer.apple.com/documentation/avfaudio/avaudiosession/mediaserviceswereresetnotification) — authoritative audio-server reset signal.
- [QA1749: Handling media services reset](https://developer.apple.com/library/archive/qa/qa1749/) — authoritative recovery requirement to recreate audio objects after reset.
- [Handling audio interruptions](https://developer.apple.com/documentation/AVFAudio/handling-audio-interruptions) — authoritative interruption lifecycle guidance.

## Android

- [WorkManager reference](https://developer.android.com/reference/androidx/work/WorkManager.html) — authoritative durable/persistent work abstraction.
- [Support for long-running workers](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running) — authoritative foreground execution for long WorkManager jobs.
- [Foreground-service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout) — authoritative timeout and `onTimeout` behavior.
- [Android 15 foreground-service changes](https://developer.android.com/about/versions/15/changes/foreground-service-types) — authoritative six-hour aggregate limit for `mediaProcessing` foreground services.
- [Restrictions on starting foreground services from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) — authoritative background-start constraints.

## Qwen and sherpa-onnx

- [Official sherpa-onnx Qwen3 file decoder](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/offline-qwen3-asr-decode-files.py) — reference configuration for offline Qwen decoding.
- [sherpa-onnx Qwen3 recognizer implementation](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc) — implementation-level runtime behavior.
- [Official sherpa-onnx Swift API example](https://github.com/k2-fsa/sherpa-onnx/blob/master/swift-api-examples/SherpaOnnx.swift) — reference Swift configuration and lifecycle.
- [sherpa-onnx Qwen streaming discussion](https://github.com/k2-fsa/sherpa-onnx/issues/3865) — current project-level evidence that the Qwen path should be treated as offline/windowed rather than a mature streaming endpoint.
