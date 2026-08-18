# Maina

Maina is a private Android meeting recorder for the Pixel 9 Pro: durable local audio, best-effort live Hindi/English/Hinglish transcription, meeting history, and transcript export. It is a personal project, not a public service.

## Current release candidate

v0.9.0 adds a foreground generic Bluetooth-shutter trigger, native USB/active-route evidence and recovery boundaries, isolated transcript/audio delivery, AAC-first development backups, seven-day/3 GiB recoverable audio, strict saved-audio preflight, and measurable Hindi/English switching quality. Recording still uses 10-minute recoverable WAV checkpoints and strict on-device speech.

Android's own documentation does not guarantee `SpeechRecognizer` for continuous multi-hour recognition. Audio is therefore the source of truth; live text is a convenience. Do not trust a critical meeting until the physical-device endurance checklist in ADR 0005 has passed.

## Development

Requirements: Node compatible with Expo SDK 57, npm, and network access for dependencies. A native development build or APK is required; Expo Go cannot load the local recorder module.

```bash
npm install
npm run check
```

Useful commands:

```bash
npm run typecheck
npm test
npm run lint
npx expo export --platform android
```

EAS builds are intentionally submitted only after the local gate passes and the owner explicitly authorizes a build.

## Architecture and decisions

- `docs/decisions/0005-durable-background-capture.md` — current recording architecture and residual risks.
- `docs/decisions/0007-transcription-trust-and-hid-trigger.md` — current ASR/button decision and device gates.
- `docs/CHANGELOG.md` — version history.
- `docs/HANDOFF.md` — product context, audit evidence, and security notes.
- `src/core/transcription/` — swappable speech wrapper and transcript merge logic.
- `modules/maina-recorder/` — app-owned Android foreground/recovery module.
- `patches/` — reviewed upstream package patch applied after every install.

## Privacy

Speech is forced on-device. Android Auto Backup is disabled. During development, scrubbed logs, transcripts and compressed recovery audio are intentionally uploaded to private Supabase diagnostics with insert-only APK policies. Never commit provider, Expo, GitHub, Supabase management, Sentry, or LLM API tokens.
