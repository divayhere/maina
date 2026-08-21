# Local-ASR qualification protocol

## Decision rule

No ASR model becomes Maina's default merely because it runs. It must pass both
quality and device-reliability gates on the Pixel 9 Pro.

## Benchmark corpus

Use retained, consented staging audio only. Each sample must have a manually
verified reference transcript or an adjudicated semantic checklist.

| Group | Minimum samples | What is judged |
|---|---:|---|
| Indian English | 3 | names, numbers, decisions, normal speech |
| Hindi/Hinglish | 3 | code-switching, transliteration/script fidelity not required |
| Far-field room | 2 | whole utterances retained |
| Noise / AC / car | 2 | important meaning survives |
| Multi-speaker / overlap | 2 | no destructive loss; no false speaker guarantee |
| Long capture | 1 x 60 min | thermal, memory, coverage, recovery |

## Model scorecard

Score each test on a 1–5 scale and retain the raw transcript, timings, memory,
battery slope and errors.

| Dimension | Weight | Failure threshold |
|---|---:|---|
| Audio coverage / no skipped windows | Critical | any unaccounted interval fails |
| Decision / negation / number preservation | Critical | material reversal fails |
| Hindi/Hinglish word recognition | High | repeated systematic corruption fails |
| Indian English recognition | High | repeated systematic corruption fails |
| Hallucination / repetition behaviour | High | unrecoverable loop fails |
| Pixel thermal / memory stability | High | crash, kill, or unsafe sustained growth fails |
| Processing time | Medium | more than 1 hour for a 1 hour recording without a recoverable reason |
| Punctuation / script formatting | Low | never a release blocker |

## Existing desktop evidence (not a release decision)

- Qwen3-ASR 0.6B INT8 decoded a 30-second Indian-English sample at RTF 0.137
  and produced a coherent transcript.
- It decoded an opening Hindi sample correctly at RTF 0.146.
- A denser Hindi sample required a larger token allowance and still made
  proper-noun/word errors. This proves neither perfect Hinglish performance nor
  final Pixel suitability.
- Qwen used approximately 1.9–2.4 GB RSS on Mac for these short tests.

Therefore Qwen was **eligible for a Pixel proof**, rather than selected from
desktop evidence alone.

## Pixel staging evidence — 2026-08-20, v0.10.0

The current staging primary is Qwen3-ASR 0.6B INT8 through sherpa-onnx. A
release-mode Pixel 9 Pro run used the normal Maina capture, saved-audio retry,
local-ASR and packet-generation paths rather than a desktop-only harness.

- One 26.119-second WAV window decoded locally in 4.640 seconds (RTF 0.178).
- The input measured -33.264 dBFS RMS and -11.821 dBFS peak through the
  connected Hollyland USB microphone.
- The run produced 23 words, accounted for the complete audio interval, left
  zero partial chunks, and did not crash or ANR.
- Transcript: “Mena quality control test. We agree to deliver the customer
  report tomorrow. Revenue increased by 20%. Please create a follow-up task for
  Devay.” The intended proper names were “Maina” and “Divay”; the material
  meaning, number, decision and action were retained.
- The resulting transcript automatically produced a Gemini packet using the
  saved provider configuration: one decision, one open to-do and no open
  questions.
- Post-run process memory was approximately 252 MB PSS. The recognizer is
  released after each pipeline run rather than retained during idle recording.

This qualifies Qwen as Maina's **short-run staging primary** and proves the
capture -> finalization -> local transcription -> cloud packet sequence on the
target phone. It is not evidence of perfect recognition or production
readiness. Hindi/Hinglish benchmark clips, a 60-minute ASR run, a 2–3-hour
capture/recovery soak, thermal/battery measurements and microphone-route
transition coverage remain mandatory qualification gates.
