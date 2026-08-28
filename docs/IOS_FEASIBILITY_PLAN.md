# Maina iOS Feasibility Plan

## Purpose

Qualify Maina on a spare iPhone 15 without changing Android behaviour. The iPhone 17 Pro is added only after the iPhone 15 proves the local-first recording pipeline.

## Platform boundary

Shared TypeScript owns meetings, SQLite schema, transcript persistence, packet generation, MKC sync, retention policy, diagnostics contract, and UI. The `maina-recorder` local Expo module owns platform recording and ASR details:

| Capability | Android | iOS feasibility implementation |
| --- | --- | --- |
| Durable capture | `AudioRecord` foreground service | `AVAudioRecorder` with audio background mode and durable WAV chunks |
| Route changes | `AudioRecord` route bridge | `AVAudioSession` route/interruption observers |
| Local ASR | Sherpa ONNX Android AAR | Sherpa ONNX iOS XCFramework |
| Long processing | foreground service plus deferred work | persisted per-window recovery on foreground/relaunch; extended background processing remains a later gate |
| Generic shutter control | Accessibility key filter | Unsupported; never emulate it |
| Interim trigger | Bluetooth shutter | iPhone 15 Back Tap -> Maina Shortcut proof only |
| iPhone 17 Pro trigger | Bluetooth shutter | Action Button -> Maina App Shortcut proof only |

## Non-negotiable reliability rule

iOS may interrupt or terminate background work. Therefore each audio segment and ASR window must be independently durable and represented in a manifest. A later launch/task resumes unfinished windows; it never recomputes stable windows or deletes source audio before verified transcription.

## Build sequence and proof standard

The iOS branch is qualified in this order. A later gate cannot hide an earlier failure.

1. **Native capture:** `AVAudioSession` with the `record` category and an active `audio` background mode owns the microphone. It writes 16 kHz mono PCM WAV chunks into the existing Maina meeting folder.
2. **Durability:** a `capture-journal.jsonl` records start, closed chunk, pause, route recovery, interruption, and stop boundaries. A completed chunk is atomically renamed from `*.partial.wav` to `*.wav`; malformed partial files are retained, never misrepresented as valid audio.
3. **Continuity:** input route changes and resumable system interruptions close the active chunk, wait briefly for iOS to settle, then reopen the next chunk within the same meeting ID. The measured gap and recovery count are stored.
4. **Local ASR:** the Qwen3-ASR 0.6B INT8 model family used by Android is installed in app storage, not embedded in the IPA. The installer needs a manifest, SHA-256 checks, temporary download directory, atomic final move, storage preflight, and resumable download. Sherpa-ONNX remains the runtime boundary, so a later ASR model swap does not change meetings, notes, MKC sync, or UI contracts.
5. **Post-capture continuation:** ASR persists each window result before moving to the next. The current iOS build safely resumes unfinished work when Maina returns to the foreground. iOS does not yet have a qualified extended-processing task, so immediate completion after backgrounding is not promised.
6. **Packet and cloud:** only a durable transcript becomes eligible for the existing cloud-notes and MKC pipeline. Raw audio stays local and follows the existing retention policy.

## First-device test matrix

| Test | Pass condition |
| --- | --- |
| Start / pause / resume / stop | One meeting, valid WAV chunks, correct terminal state |
| Locked 30-minute built-in-mic capture | Continuous duration within two seconds of wall clock |
| Route fallback | USB/Bluetooth removal keeps the same meeting; measured loss at or below three seconds where iOS/hardware permits |
| Phone call / interruption | Completed chunk retained; auto-resume only when iOS signals it may resume |
| Force quit/relaunch | Finished chunks discovered; invalid partial stays available for recovery rather than disappearing |
| English, Hindi, Hinglish decode | Per-window output is persistent and notes/MKC run only after complete coverage |
| Cloud idempotency | One finalized meeting yields one frozen source; retry does not mutate it |

## Explicit operating limits

- A microphone `audio` background session is the correct way to sustain live recording while locked. iOS does not provide an API that makes a process unkillable.
- A phone call, media-service reset, or physical input switch can create a short gap. Maina targets a bounded, measured recovery rather than pretending the input never changed.
- iPhone 15 has no Action Button. Back Tap can run an App Shortcut as a test trigger, but it is not generic lock-screen HID-key interception.
- Generic Bluetooth shutter remotes and physical volume/power interception are intentionally unsupported on iOS.

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

## P0 before the next iOS installation

The current five-test physical qualification may run unchanged on the installed
build. Before the *next* iOS build is installed, complete the release blocker in
`docs/PERSONAL_SIGNING_RENEWAL_AND_DATA_PRESERVATION.md`:

1. Rebase historical iOS recording URIs to the current app container and make
   future persisted recording references container-portable.
2. Add a first-party weekly Personal Team renewal command with idle-state
   refusal, full local backup, signing/entitlement verification, in-place
   installation, and post-install data checks.
3. Preserve and pin Android's existing signing identity and add equivalent
   in-place update safeguards without enabling Android cloud/device backup.

This item is a hard release prerequisite, not a prerequisite for the five
currently planned capture/recovery tests. Any evidence discovered by those
tests must be folded into the implementation before the next installation.
