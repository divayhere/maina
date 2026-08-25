# ADR 0009 — Capture-first local ASR pipeline

**Status:** Accepted for the next staging implementation  
**Date:** 2026-08-20

## Context

Maina's existing Android implementation uses `expo-speech-recognition` as
both the live recognizer and the owner of the microphone recording. This is
useful for a small live preview, but it makes durable audio persistence depend
on a continuous speech-recognition session. Android does not guarantee that
such sessions are suitable for multi-hour recognition, mixed Hindi/English, or
recoverable foreground capture.

Maina's product contract is stricter: audio capture must survive ASR failure,
network failure, slow UI, language switching, and an interrupted app process.

## Decision

1. Maina will have exactly one native Android `AudioRecord` owner during a
   capture. The foreground microphone service owns it.
2. The service persists fixed-duration PCM/WAV chunks through a crash-safe
   lifecycle: `*.partial` write -> periodic sync -> WAV header finalization ->
   atomic rename -> durable manifest entry.
3. The capture path never invokes ASR, cloud providers, UI rendering, or
   remote diagnostics synchronously.
4. ASR is a post-capture job over immutable audio chunks. Its public contract
   is model-neutral. Qwen3-ASR through sherpa-onnx is the first candidate, not
   a permanently embedded assumption.
5. Audio segmentation cannot discard audio. VAD can suggest ASR boundaries,
   but fixed coverage windows are authoritative so a whispered or far-field
   utterance cannot be skipped merely because VAD missed it.
6. A transcript is marked `complete` only after every retained audio interval
   has a terminal processing result. This is a coverage state, not a promise
   that every word is correct.
7. Android SpeechRecognizer remains a temporary optional preview adapter until
   the native capture + local-ASR proof has passed Pixel reliability gates. It
   is never the authoritative capture path after migration.

## Audio-source policy

The service exposes a calibration route rather than assuming one source is
best for every phone/microphone:

- `UNPROCESSED` when supported;
- `VOICE_RECOGNITION` as the conservative speech path;
- `CAMCORDER` as a far-field comparison candidate;
- an explicit route/source result stored in diagnostics.

`VOICE_COMMUNICATION` is not the default because its call-oriented processing
can change gain/noise behaviour. No global denoise, AGC, echo cancellation or
source separation is allowed to replace master audio. Analysis copies may be
created later, but the original chunks remain immutable.

## Model-pack policy

The Qwen3-ASR 0.6B INT8 package is approximately 1 GB. It must be a versioned
downloaded model pack with checksum, manifest, disk-space preflight and an
explicit installed/verified state. It is not bundled inside the ordinary APK.
This keeps the APK practical and allows later model replacement without a
capture/UI migration.

## Consequences

- The native module grows, but the React Native UI becomes less responsible
  for recording survival.
- Audio remains available for retry for the configured 7-day / 1-GB retention
  window.
- A model adapter can be replaced without changing the meeting schema, audio
  journal, cloud-summary connectors, clicker logic, export format, or UI.
- A local APK cannot be released until native capture recovery and at least a
  bounded Qwen proof run on the Pixel pass.

