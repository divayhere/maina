# ADR 0007 — Transcription trust and generic HID trigger

Status: **Accepted for v0.9.0 device validation** · Date: 2026-08-18

## Decision

Keep the Pixel's on-device Android recognizer as Maina's live English/Hindi/Hinglish engine for this release. Do not replace it with an unbenchmarked open-source model. Treat the incrementally written audio as the recoverable source of truth, retain it for seven days subject to a 3 GiB oldest-safe-first cap, and expose a strict saved-audio preflight before any re-pass.

Add direct support for generic Bluetooth selfie remotes while Maina is visible. Android pairs the remote as an OS-level HID keyboard; Maina consumes common volume, camera, enter, media-play and headset key codes in `MainActivity` and maps one debounced release to start/stop. Maina does not implement proprietary Bluetooth pairing.

## Evidence and rationale

- Android documents `SpeechRecognizer` as not intended for guaranteed continuous recognition, but it is the only already-proven, zero-cost, instant bilingual engine on the Pixel.
- Google's ML Kit GenAI Speech API Basic mode uses the traditional on-device model. Advanced mode is Pixel 10-only and the API remains alpha, so it is not an accuracy upgrade for the Pixel 9 Pro.
- AI4Bharat IndicConformer plus sherpa-onnx is a serious benchmark candidate, but the multilingual model is roughly 600M parameters and phone far-field Hinglish/code-switch quality is not yet proven in Maina's corpus.
- Otter and Fireflies use connectivity/cloud processing for their polished live experience. Otter's own guidance says it records locally first and uploads afterward. Maina deliberately keeps its free/offline default rather than pretending those systems are equivalent.
- Generic shutter remotes normally emit HID volume keys. A normal Android app can intercept these reliably in its foreground Activity; global background interception would require an accessibility-service misuse or proprietary SDK and is rejected for this personal sideload build.

## Reliability details

- Transcript artifacts are scheduled ahead of audio artifacts and one audio failure cannot block text.
- AAC-LC/M4A at 32 kbps is the primary development-backup codec on this Pixel; Opus remains fallback after the observed Pixel Opus stall.
- Native artifact failures include meeting, segment, source existence/size, attempt and exception details in Supabase.
- Active recording configuration and external USB input add/remove events are logged natively. USB removal triggers an immediate recognizer segment restart; reconnect triggers a delayed clean segment boundary.
- Exact transmitter-off detection is not claimed. A live USB receiver can remain a valid Android input while its transmitters send silence.
- ASR runs now report final/partial counts, confidence samples, Hindi/English detections and actual language-switch outcomes without flooding every low-confidence detection.

## Required validation

1. Pair the POPIO remote in Android Settings and identify the key codes from Supabase/ADB.
2. Run a fixed English → Hindi → Hinglish → English script twice, once on the Pixel mic and once on Hollyland.
3. Confirm one button press starts and one stops while Maina is visible; confirm the phone volume does not change.
4. Disconnect/reconnect the Hollyland once and measure the actual segment gap.
5. Record at least 20 minutes, then verify transcript upload, AAC artifact upload time, seven-day local recovery status and saved-audio re-pass.

## Next engine gate

Before integrating sherpa-onnx, Whisper, ML Kit Advanced or another model, run the same labelled corpus and compare word error rate, code-switch errors, real-time factor, battery, thermal behaviour and package/model size. Canonical transcripts remain verbatim; any LLM cleanup or English translation is a separate derived view.
