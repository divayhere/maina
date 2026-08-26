# Maina Mobile Cloud Notes Client — Release Checklist

## Objective

Let Android keep capture, audio recovery, local Qwen transcription, and the
local transcript fully operational without a network connection.  When the
phone is paired to the same Maina Cloud account, send only a finalized local
transcript to the server for durable notes generation and MKC sync.

## Non-negotiable invariants

- No browser password, owner API token, LLM key, model picker, or editable MKC
  URL is rendered or persisted by Android.
- Android stores only a revocable, scoped Maina Cloud session in
  `expo-secure-store`.
- Cloud failure never changes a successful local capture/transcript into a
  failed meeting.
- Notes are generated from a frozen server job.  A later regeneration creates
  correction lineage; it does not mutate an immutable meeting source.
- Local capture remains usable before pairing, while offline, and after logout.

## Implemented in this branch

- One-time device pairing/session exchange and secure local session lifecycle.
- Cloud connection UX that exposes account state and logout only after pairing.
- Legacy direct-provider and direct-MKC settings are deleted on startup and on
  successful pairing; they are not used as a fallback.
- Durable cloud-notes job creation, polling, bounded retry, ready-packet save,
  source-sync queueing, and correction queueing.
- Truthful server section progress is persisted into the existing meeting
  pipeline for long transcripts.
- Pairing code is shown in full; the request identifier is available for the
  owner Web approval surface without showing a provider credential.

## Deliberate boundaries

- The current production notes adapter is Google.  OpenAI and Anthropic are
  server-only adapter additions; Android's request and response contract stay
  unchanged.
- The app does not upload audio.
- A pairing approval screen in Maina Cloud Web remains required before a real
  phone can obtain its scoped session.  The deployed API already supports
  approve/exchange; Web must present the owner-facing interaction.
- A release APK is not approved until the native verifier and live device
  pairing/job/source-sync qualification are all green.

## Release gates

1. `npm test`, `npm run typecheck`, `npm run lint`, and
   `npm run verify:coordination` pass in this worktree.
2. `bash scripts/verify-release.sh` reaches successful native completion using
   the deterministic MainaV2 toolchain.
3. Fresh APK installs over the test phone without local-capture regression.
4. Owner approves a phone in Maina Cloud Web; app exchanges a scoped session.
5. A content-safe real meeting exercises: local transcript → server packet job
   → ready packet → immutable source sync.
6. A deliberately expired/revoked mobile session becomes a reconnectable cloud
   failure while the local transcript remains available.
7. A regenerate action produces correction lineage rather than a mutation
   conflict against the already-synced source.

## Cross-repository source of truth

- Coordination state: `coordination/state.json` and `coordination/workplan.json`.
- Server contract: Maina Knowledge Cloud `docs/API.md` and
  `docs/MAINA_INTEGRATION_REGISTRY.md`.
- No secret, raw token, pairing code, or customer transcript belongs in this
  checklist or the coordination repository.
