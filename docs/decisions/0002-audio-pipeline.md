# ADR 0002 — Audio capture & transcription pipeline

Status: **Accepted** · Date: 2026-08-17

## Context
whisper.rn only accepts 16 kHz mono 16-bit **PCM WAV**; it does not decode AAC/MP3/FLAC.
Android's standard recorder (and expo-audio) produce AAC/m4a, which whisper cannot read, and Android's MediaRecorder cannot emit WAV/PCM.

## Decision
- **Capture** with `@fugood/react-native-audio-pcm-stream` (audio source = VOICE_RECOGNITION), which writes a 16 kHz mono WAV directly — no transcoding step. Replaces expo-audio for recording. expo-audio is kept only for the microphone **permission** prompt.
- **Transcribe** with `whisper.rn` (`initWhisper` + `context.transcribe`). Models are ggml files downloaded on demand to app storage; default `base` multilingual (~148 MB), swappable to `small` for better Hindi.
- **Buffer polyfill:** whisper.rn → safe-buffer needs Node's `buffer`; added the `buffer` npm package so Metro resolves it.
- **Privacy:** audio WAV is deleted immediately after a transcript is saved (config `audioAutoDelete`, default on).

## Consequences
- Recording is whisper-ready with zero conversion, and the pipeline stays offline + free.
- Known limitation (to harden later): current capture buffers to a WAV file natively; very long meetings and background/foreground-service recording are Phase 4/5 hardening.
- Swap-seam intact: a different transcription engine only needs to satisfy `TranscriptionEngine` and accept the same WAV.
