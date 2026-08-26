# Maina ASR completion reliability

## Objective

Maina must not label a complete recording as failed merely because a normal
silent or noisy room interval produces no transcript text.  Audio remains
local; Qwen remains the single post-capture transcription model.

## Production sequence

1. Native `AudioRecord` writes durable 16 kHz mono PCM WAV chunks.
2. Recording finalization verifies the durable WAV boundaries.
3. Each overlapping 15-second ASR window is classified locally by the bundled
   Sherpa/Silero VAD model before Qwen runs.
4. `silence` is recorded as `skipped_silence` and is terminal success.
5. `uncertain` is sent to Qwen once. A blank result is terminal no-content,
   not a false recovery failure.
6. Confirmed `speech` is sent to Qwen. A blank result or token cap receives
   bounded low-energy split recovery.
7. Confirmed speech that remains unresolved is persisted as `retry_pending`.
   Its WAV is retained; only that interval is eligible for a later retry.
8. A transcript is complete only when every window is either complete or
   skipped silence. Only then may downstream notes and MKC ingest use the
   canonical transcript.

## Deliberate non-features

- No global AGC, denoise, or audio trimming.
- No second ASR model or cloud transcription fallback.
- No automatic deletion merely because a recording is short or quiet.
- No silent MKC source mutation from partial/corrected local transcript text.

## Qualification requirements before APK

- Kotlin unit tests cover silence, ambiguous audio, sustained speech, and
  intermittent noise policy decisions.
- Native source verifier checks the pinned VAD asset hash and that the bundled
  Sherpa runtime exposes the VAD API.
- Android compile/unit-test and full release verification pass.
- Device qualification must cover: quiet silence, room noise, English, Hindi,
  Hinglish, Qwen token-boundary recovery, a forced Qwen error, and app reopen
  after a pending interval.

## Known platform boundary

Android can delay background continuation and limits `mediaProcessing`
foreground-service time. Maina therefore checkpoints every window and keeps
the source WAV until terminal success or retention expiry. It does not claim
instant automatic recovery after an Android-forced stop.
