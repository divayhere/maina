# Maina

Maina is a private Android meeting recorder for the Pixel 9 Pro: durable local audio, best-effort live Hindi/English/Hinglish transcription, meeting history, and transcript export. It is a personal project, not a public service.

## Current release candidate

v0.8.1 adds a durable native diagnostic outbox, compressed seven-day Supabase development backups, automatic English/Hindi provisioning, constrained Hinglish switching, recovery uploads, measured capture gaps, recoverable upload retries, and optional Sentry crash capture. Recording still uses 10-minute recoverable WAV checkpoints and strict on-device speech.

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
- `docs/CHANGELOG.md` — version history.
- `docs/HANDOFF.md` — product context, audit evidence, and security notes.
- `src/core/transcription/` — swappable speech wrapper and transcript merge logic.
- `modules/maina-recorder/` — app-owned Android foreground/recovery module.
- `patches/` — reviewed upstream package patch applied after every install.

## Privacy

Speech is forced on-device. Android Auto Backup is disabled. Supabase remote logging is disabled until its anonymous read policy is removed. Never commit provider, Expo, GitHub, Supabase management, Sentry, or LLM API tokens.
