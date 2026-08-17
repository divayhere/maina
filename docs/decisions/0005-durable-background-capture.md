# ADR 0005 — Durable background capture around best-effort live speech

Status: **Accepted for v0.7.0 release candidate** · Date: 2026-08-18

## Decision

Use Android's on-device `SpeechRecognizer` for immediate Hindi/English/Hinglish text, but never treat it as the meeting's source of truth. The source of truth is 16 kHz mono PCM written incrementally to 10-minute WAV files while a native microphone foreground service keeps Android in the correct background execution state.

The recognizer is forced on-device. If on-device support is unavailable, recording is blocked rather than silently switching to a network recognizer.

## Why

- The old Whisper path was dramatically slower than real time on the Pixel and failed badly on difficult audio.
- The native recognizer is fast, but Android explicitly documents `SpeechRecognizer` as unsuitable for guaranteed continuous recognition. Upstream also reports lost finals on `stop()` and silent interruption failures.
- The package's recorder wrote raw PCM and loaded the complete file into heap on stop to add a WAV header. At 16 kHz/mono/16-bit, that is about 115.2 MB per hour and creates a predictable multi-hour out-of-memory risk.
- A foreground service is Android's documented mechanism for continuing microphone capture after the app backgrounds or the screen locks.

## Implementation boundaries

- `modules/maina-recorder`: native foreground service, input inventory, interrupted-WAV header repair.
- `patches/expo-speech-recognition+56.0.1.patch`: bounded-memory incremental WAV output with five-second header checkpoints and thread-safe stop.
- `src/app/record.tsx`: restart/rotation state, five-second transcript/database checkpoints, bounded final-result wait, health telemetry.
- `recording_segments`: durable metadata for every expected WAV file.

## Chunk decision

Ten minutes is a storage/recovery boundary, not an ASR context window. At the fixed audio format it is ~19.2 MB. This keeps file count low (six/hour), bounds loss/corruption scope, avoids the overhead and context damage of 30-second post-processing chunks, and stays easy to share or reprocess.

## Consequences and residual risks

- A forced file rotation creates a sub-second recognizer restart gap every ten minutes.
- If Android suspends or terminates the recognition service, audio should survive but live text may have a gap.
- The foreground notification is mandatory and intentionally cannot be hidden.
- Far-field Hindi/Hinglish accuracy, USB-C receiver channel behavior, thermal load, battery drain, calls, Bluetooth route changes, and two-hour screen-off endurance require physical Pixel testing.
- This release does not add diarisation, summaries/to-dos, or the Bluetooth trigger.

## Rejected for this release

- Whisper-large on the phone: measured failure on speed and thermals.
- ML Kit GenAI Speech Advanced Mode: Pixel 10-only at the time of review; the Pixel 9 can use only the traditional model.
- Sherpa-ONNX as an immediate replacement: promising and modular, but Indic streaming/code-switch quality is not sufficiently proven to spend the only device build on it.
- Cloud streaming ASR: violates the zero-recurring-cost/private default.
