# Long-meeting reliability release scope — 2026-08-26

## Release objective

Make Maina dependable for 1–3 hour recordings on the qualified Pixel path without
changing the local Qwen ASR contract or the Maina Knowledge Cloud payload contract.

## Included

1. **Bounded input-route recovery**
   - Keep the same recording session through USB, wired, Bluetooth, and built-in
     microphone changes.
   - Retry the external route briefly, then deliberately remove its preference and
     let Android select its default input.
   - Stop pretending capture is live if no input can start inside 2.8 seconds;
     preserve finalized WAV chunks and invoke the normal save/post-processing path.
   - This follows Android `AudioRecord` routing: it exposes routing callbacks and
     permits a null preferred device to restore default routing.
     <https://developer.android.com/reference/android/media/AudioRecord>

2. **Durable post-processing recovery**
   - Preserve local WAV chunks and the native ASR outbox/failed-window manifest.
   - Keep the existing foreground-service post-processing path for an immediate,
     user-visible continuation after recording stops.
   - Retain the existing WorkManager recovery request and foreground/app-launch
     reconciliation for interrupted work. Android does not permit us to promise
     immediate invisible continuation after a reboot or arbitrary background start.
     <https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running>

3. **Pocket-readable controls**
   - Confirmed start, pause, resume, and final save have different native vibration
     patterns. A requested click never vibrates before native capture reaches the
     requested state.

4. **Truthful, compact UI**
   - Remove live transcript rendering from the recording screen; it is post-call
     Qwen transcription, not dictation.
   - Keep the audio-level halo dynamic from a 4 Hz native status snapshot.
   - Use one concise recording state and one short safety/process state.
   - Distinguish recorded-audio duration from session elapsed time after pauses.
   - Remove meeting-detail configuration jumps; Settings remains the configuration
     home, while meetings show only the active pipeline state or recovery action.

## Explicitly excluded

### Full speaker diarization

Do not add full multi-speaker diarization to this reliability release. Sherpa supports
on-device diarization, but it requires a segmentation model plus an embedding model and
has a materially different compute/asset lifecycle from Qwen ASR.
<https://k2-fsa.github.io/sherpa/onnx/speaker-diarization/apk.html>

### Future `You` verification

The next safe speaker feature is optional `You` verification, not every-person naming:

1. Install one signed/verified local speaker-embedding model through the same installer
   used for ASR models.
2. Ask for several short enrollment phrases and store only the resulting local embedding.
3. Run verification after transcript completion against speech regions.
4. Label only high-confidence matching regions `You`; leave everything else `Other`.

Sherpa documents local embedding, enrollment, search, and verification APIs. The model
file is a real additional local asset and must be integrity-checked before this can be
called a feature—not represented by a non-working setup screen.
<https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/c-api/docs/speaker-embedding.dox>

## Qualification gates before APK approval

- Typecheck, lint, all JS tests, and native recorder unit tests pass.
- Native Android compilation passes from the pinned MainaV2 toolchain.
- Static release verifier passes.
- Device test after APK install:
  - start/pause/resume/stop haptics,
  - 10–15 minute audio capture,
  - one physical route change to phone fallback,
  - full Qwen completion, notes, and MKC sync,
  - duration wording after a pause,
  - no configuration button appears inside a completed meeting.

## Known realistic limits

- A physical input change can lose up to the bounded recovery interval; a 1–3 second
  loss is accepted, zero-loss is not guaranteed by Android routing hardware.
- One microphone cannot reliably transcribe simultaneous overlapping speech as two
  independent voices.
- On the Pixel, local Qwen ASR is completion-first rather than cloud-speed. The durable
  outbox makes interruption recoverable; it does not make CPU inference instant.
