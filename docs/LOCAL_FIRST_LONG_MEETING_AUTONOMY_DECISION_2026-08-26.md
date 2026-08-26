# Maina local-first long-meeting autonomy decision

**Date:** 2026-08-26
**Decision:** Keep the native-recording → local-Qwen → cloud-notes/MKC architecture. Do not add a second ASR model. Replace the current manual terminal-recovery behavior with a bounded adaptive recovery state machine.

## Observed failure

The 12:10 test meeting preserved audio and produced 21 transcript blocks, but one of thirteen ASR windows remained incomplete. The Sherpa Qwen runtime logged that `max_new_tokens=128` was too small. Two capped windows recovered after splitting; one did not. Maina then persisted `partial`, which blocks notes and MKC sync.

## Product rule

Audio is the durable source of truth. A completed transcript is eligible for notes and MKC sync. A partial transcript is not silently treated as final, because Maina Knowledge Cloud sources are immutable and a later correction needs explicit lineage.

## Chosen recovery ladder

1. Normal local decode: Qwen window with the qualified 128-token budget.
2. Only when the runtime reaches the real output cap: retry that same window with 256 tokens.
3. If it still caps: split at a low-energy/VAD boundary and retry the smaller windows with 256 tokens.
4. If still capped: use bounded 3.75–5 second pieces, preserving exact sample coverage and durable per-window evidence.
5. Persist every completed result immediately. On process death/reboot, resume only unfinished windows.
6. If Android defers work or the first session is interrupted, automatically queue a uniquely named recovery request. The next permitted processing opportunity resumes from the durable manifest; it never recomputes a full meeting.
7. Only after the bounded ladder is exhausted should the meeting be marked `needs_attention`; it remains queued and keeps audio under the incomplete-audio retention policy.

The app should show this as progress (for example, “Finishing transcript — 12 of 13 sections”) rather than asking the user to press Retry. A single notification is appropriate only after the automatic deadline is exhausted.

## Three-hour meeting implication

Recording remains a microphone foreground-service use case. Post-processing is a media-processing foreground-service use case with a six-hour Android 15 daily budget. Maina's tested Pixel baseline is roughly half real time for ordinary local ASR, so a three-hour meeting is expected to need roughly 1.5–2.5 hours of post-processing under favourable thermal conditions. This is a target to qualify on device, not a promise for every lower-end Android phone.

## Explicit non-goals

- No global 512-token setting without a Pixel thermal/RAM qualification.
- No Whisper/Zipformer/Parakeet cascade.
- No final MKC sync from an incomplete transcript.
- No user requirement to revisit historic meetings and press manual retry.

## Evidence

- Qwen official ASR wrapper defaults `max_new_tokens` to 512: https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/qwen3_asr.py
- Qwen official splitting uses low-energy boundaries and preserves all samples: https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/utils.py
- Sherpa Qwen uses a per-stream `max_new_tokens` setting and reports truncation when it is reached: https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc
- Android WorkManager persists work across reboot and supports unique work plus backoff: https://developer.android.com/develop/background-work/background-tasks/persistent
- Android media-processing foreground services have a six-hour total daily budget on Android 15+: https://developer.android.com/develop/background-work/services/fgs/timeout

## Release gate

Before an APK: replay the saved failing Hindi/English test audio through the new ladder, run existing unit/native tests, then qualify a real 30–60 minute Pixel meeting including a reboot during post-processing. A three-hour qualification is required before promising week-long production use for three-hour meetings.
