# Maina mobile cloud physical qualification — 2026-08-27

This record contains sanitized release evidence only. It intentionally excludes
pairing codes, session tokens, owner credentials, transcript bodies, provider
credentials, and customer content.

## Release identities

- Android branch: `codex/mainav2-clean-baseline`
- Android app: `0.10.27 (53)`
- Android package: `com.divay.maina`
- Android APK SHA-256: `ee6f58535dfa876c1865e70a94f03740e9882ccdcce04ecb8b2028bfabb87a0b`
- Android target: Pixel 9 Pro (`caiman`)
- iOS branch: `codex/ios-feasibility`
- iOS source head at qualification: `44cf1b800c82fbb6d9d10c55394d8e2082808429`
- iOS installed staging app: `0.10.24 (7)` / `com.divay.maina.staging`
- iOS target: iPhone 15 (`iPhone15,4`)
- MKC meeting-notes kernel: `meeting-notes-kernel-2026-08-27.2`
- MKC Worker version: `6cb7d8d4-41ed-4608-af29-706e757d0826`

## Automated evidence

- Android deterministic release verification passed.
- Android TypeScript, lint, Expo dependency, native recorder, config parity,
  Kotlin, CMake, and manifest gates passed.
- Android test suite passed: 25 files / 109 tests.
- Android release APK signature v2 verification passed.
- iOS focused session tests passed: 5/5.
- iOS TypeScript, lint, and native recorder verification passed.
- Both clients preserve the case-sensitive one-time pairing credential.
- Both clients accept the deployed exchange identity shape (`user.id`); Android
  retains legacy `user_id` parsing only for backward compatibility.

## Physical and production evidence

- Android fresh APK installed on the exact Pixel with retained local meetings.
- Android owner-approved pairing completed through the deployed MKC API.
- The Android scoped session persisted across force-stop and relaunch.
- A finalized local Android transcript automatically queued one meeting-packet
  job, reached `ready` with truthful `1/1` progress, rendered Notes ready, and
  showed Synced to cloud.
- Android immutable source ingest created exactly one source and one packet job.
- Android post-source note material produced five append-only corrections for
  title, summary, decisions, to-dos, and open questions.
- Android session revocation changed only cloud state to Local only. The local
  meeting and transcript remained intact. A new owner-approved pairing restored
  Connected state and survived another force-stop/relaunch.
- Stale qualification sessions were revoked; one active Android session remains.
- The installed iPhone 15 build independently shows its equivalent synthetic
  meeting as Notes ready and Synced to cloud.
- The iOS synthetic source and packet job each exist exactly once and the job is
  `ready` with truthful `1/1` progress.
- Android and iOS used the unchanged `mkc.meeting-packet.v1` request surface and
  produced structurally and semantically compatible notes. Prose equality was
  not required because provider output is nondeterministic.
- Provider selection, credential use, and the effective meeting-notes
  instruction remained server-side. Neither phone displays or sends a prompt,
  provider key, model picker, provider picker, owner token, or editable MKC URL.

## Proven local-first boundaries

- Local recording and transcription remain usable before pairing and after
  session revocation.
- Cloud authentication failure does not mutate a successful local meeting into
  a failed recording.
- Incomplete ASR is prevented by source tests from starting final packet/source
  publication.
- Earlier exact-device iOS qualification proved process-kill WAV repair and
  deferred local transcription recovery.
- The centralized prompt-quality v2 deployment required no mobile rebuild; new
  jobs used the deployed server instruction while mobile contracts stayed fixed.

## Residual Web UX gap

The production backend pairing route is correct and physically qualified. The
visible phone-approval form is absent from the current prompt-quality Web branch.
It exists in Web commit `8448282` on `codex/web-mobile-pairing`, but the later Web
release branch did not contain that commit. Web must reintegrate the existing
form and deploy it from its current release line. This is a Web release-lineage
gap, not a mobile protocol or backend pairing defect.

## Android device-only follow-up

Installing an APK update caused Android to disable Maina's Accessibility service.
Android security does not reliably permit the app or ADB to silently re-enable
it. The owner must enable **Settings → Accessibility → Maina** once to restore
lock-screen clicker control. Recording, local ASR, cloud notes, and sync do not
depend on this permission.
