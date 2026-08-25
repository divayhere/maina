# ADR 0003 — Hours-long recording & resumable transcription

Status: **Accepted** · Date: 2026-08-17

## Context
Core use case is **hours-long continuous recording**. Priorities: accuracy > speed (time is not a constraint), and the recording must never break even if transcription is slow, crashes, or the model reloads. Earlier the whole recording was buffered in memory (would crash on long meetings) and transcription was a single all-or-nothing call.

## Decision
- **Recording = source of truth, disk-backed, bounded memory.** Audio is written as a sequence of ~30-second WAV **segment files** (`rec-<id>/seg-0000.wav`, …). Only the current segment (~1 MB) is in RAM, so multi-hour recordings are safe. Recording never waits on transcription.
- **Transcription = separate, resumable, chunked process.** Segments are transcribed one at a time, keeping a single whisper context alive; the transcript and a `transcribed_segments` counter are persisted after each segment. If it crashes/reloads, it resumes from the last finished segment. Runs after recording (record-first) and can fall behind and catch up.
- **Model = large-v3-turbo quantized (q5_0, ~547 MB)** — user's choice for accuracy-with-reliability on a Pixel 9 Pro; strong Hindi/English, fully offline. Single local model (no picker); summarization keeps a multi-provider dropdown.
- **Robust model download** — download to a `.part` temp file, verify size ≈ expected, move into place on success, delete partials on any failure. Fixes the "half-file jams every retry" bug. Pre-download available in Settings.

## Consequences
- Multi-hour meetings won't exhaust memory; a crash mid-transcription loses at most the current 30 s segment's progress.
- Segment files double as transcription chunks (Whisper works in ~30 s windows anyway).
- DB migration v3 adds `segment_count` + `transcribed_segments`.
- Future: live/streaming transcription during recording, and background-service capture, build on this segment model.
