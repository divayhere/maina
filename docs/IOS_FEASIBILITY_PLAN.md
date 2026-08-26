# Maina iOS Feasibility Plan

## Purpose

Qualify Maina on a spare iPhone 15 without changing Android behaviour. The iPhone 17 Pro is added only after the iPhone 15 proves the local-first recording pipeline.

## Platform boundary

Shared TypeScript owns meetings, SQLite schema, transcript persistence, packet generation, MKC sync, retention policy, diagnostics contract, and UI. The `maina-recorder` local Expo module owns platform recording and ASR details:

| Capability | Android | iOS feasibility implementation |
| --- | --- | --- |
| Durable capture | `AudioRecord` foreground service | `AVAudioEngine` / `AVAudioFile` with audio background mode |
| Route changes | `AudioRecord` route bridge | `AVAudioSession` route/interruption observers |
| Local ASR | Sherpa ONNX Android AAR | Sherpa ONNX iOS XCFramework |
| Long processing | foreground service plus deferred work | continued-processing task where supported, otherwise scheduled processing fallback |
| Generic shutter control | Accessibility key filter | Unsupported; never emulate it |
| Interim trigger | Bluetooth shutter | iPhone 15 Back Tap -> Maina Shortcut proof only |
| iPhone 17 Pro trigger | Bluetooth shutter | Action Button -> Maina App Shortcut proof only |

## Non-negotiable reliability rule

iOS may interrupt or terminate background work. Therefore each audio segment and ASR window must be independently durable and represented in a manifest. A later launch/task resumes unfinished windows; it never recomputes stable windows or deletes source audio before verified transcription.

## Required iOS capabilities

- Microphone permission.
- `audio` background mode while active recording.
- On later processing implementation: permitted Background Task identifiers and an iOS-version-gated continued-processing path.
- No attempt to intercept the Power button, Volume buttons, or generic Bluetooth HID shutter keys.

## Gates

1. **Build gate:** full Xcode, iPhone 15 trusted over USB, Developer Mode, staging bundle identifier, local signed install.
2. **Capture gate:** 60-minute locked recording with built-in microphone, valid audio duration, and no silent early finish.
3. **Route gate:** USB receiver attach/remove and phone-microphone fallback; preserve one meeting and record measured gaps.
4. **ASR gate:** Qwen/Sherpa iOS loads, then Hindi, English, and Hinglish corpus decode with persisted per-window results.
5. **Recovery gate:** interrupt/force-close/reboot while processing; resume only unfinished manifest windows.
6. **Cloud gate:** finalized transcript creates notes and syncs exactly once to MKC.
7. **Trigger gate:** Back Tap App Shortcut on iPhone 15, then Action Button App Shortcut on iPhone 17 Pro. A trigger only ships if it starts the tested recording path reliably while the phone is locked.

## Explicit exclusions from feasibility

- Existing POPIO shutter clicker support on iOS.
- Claims that iOS will never terminate Maina.
- Speaker separation.
- Permanent branch divergence from Android.

## Toolchain rule

Use the isolated `codex/ios-feasibility` worktree. Build only after Xcode and sufficient free disk space are available. Do not build from the old Desktop checkout.
