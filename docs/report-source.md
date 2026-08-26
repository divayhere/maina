# Research source ledger — Maina meeting packet prompt v2

Date: 2026-08-26

Scope: formulate an economical, provider-neutral, ASR-aware prompt and structured output
contract for Maina's transcript-to-meeting-packet step. Audio remains local; this research
does not alter recording, transcription, provider credentials, or MKC contracts.

| Claim | Evidence | Source |
| --- | --- | --- |
| Structured schema output is more reliable than asking for JSON in prompt text alone. | Official provider documentation exposes JSON Schema structured-output mechanisms. | OpenAI, Gemini, Anthropic structured-output docs in `MEETING_PACKET_PROMPT_V2_SPEC_2026-08-26.md`. |
| A meeting packet should separate summary, decisions, actions, and unresolved issues. | Major meeting products consistently expose summaries/actions/transcript and decision-style notes. | Otter, Fireflies, tl;dv product documentation. |
| Cloud post-processing should be conservative. | ASR/LLM research reports correction gains but warns unconstrained rewriting can harm lexical fidelity. | Ma et al. 2023; Interspeech 2024; Future Generation Computer Systems 2026. |
| Maina must summarize only stable transcripts. | Workflow products generate automatic summaries after terminal/eligible conversation states; Maina already guards generation on terminal local transcripts. | Intercom documentation; current Maina `meetingPacket.ts`. |

Limit: no reviewed meeting product publishes its private system prompt. The proposed prompt
therefore draws from observable product behavior, provider contracts, and ASR research—not
from an unverified claim about Otter, tl;dv, Fireflies, or Intercom internals.
