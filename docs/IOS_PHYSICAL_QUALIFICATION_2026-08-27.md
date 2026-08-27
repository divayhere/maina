# Maina iOS physical qualification — 2026-08-27

## Qualified candidate

- App: Maina `0.10.24` (`7`)
- Bundle: `com.divay.maina.staging`
- Device: USB iPhone 15 (`iPhone15,4`), iOS 26.6.1
- Local ASR: Qwen3-ASR 0.6B INT8 through the sherpa-onnx iOS runtime
- Cloud notes: MKC mobile broker using Gemini Interactions
- MKC source sync: production `/v1/sources`

The iPhone 17 Pro and iPhone Mirroring were not used.

## Automated evidence

- TypeScript typecheck: passed
- Expo lint: passed
- Vitest: 26 files, 110 tests passed
- Native recorder source/capability verifier: passed
- Xcode Release build: passed
- Deep/strict code-signature verification: passed
- Installed version/build identity: confirmed on the physical device

## Real-device evidence

| Scenario | Result | Evidence |
| --- | --- | --- |
| Start, pause, resume, stop | Pass | Native lifecycle completed; saved audio excluded deliberate pause. |
| Screen-off background recording | Pass | Five- and twelve-minute captures continued with the display off. |
| Ten-minute native chunk rollover | Pass | Twelve-minute meeting produced two finalized chunks. |
| Twelve-minute local transcription | Pass | 55/55 windows completed; zero failed windows; 197 words. |
| Cloud notes | Pass | Notes job reached ready and stored a 322-character packet. |
| MKC source sync | Pass | Production source ingest returned HTTP 201. |
| Completed-audio retention | Pass | 23 MB was deleted after transcript, notes, and MKC success; DB audio pointer cleared. |
| Abrupt process termination | Pass | A killed 14-second recording had its incomplete WAV header repaired and then completed 1/1 ASR window. |
| Hindi/Hinglish sample | Pass | Two-window local run completed without a failed window. |
| Indian-English sample | Pass | Two-window local run completed without a failed window. |
| Crash/Jetsam audit | Pass | No Maina crash report and no Maina process in copied Jetsam reports. |
| Parallel note recovery | Pass after fix | Meeting-packet execution is serialized; final build produced no nested SQLite transaction errors. |

The twelve-minute meeting persisted `recording`, `audio_finalized`, `asr`,
`transcript_durable`, `summary`, and `mkc` stages as ready. The source audio no
longer existed after successful retention cleanup.

## Defects corrected during qualification

1. Native recorder methods no longer block the React Native caller while work is queued.
2. App lifecycle reconciliation reads the native recorder as the source of truth.
3. Audio metering is asynchronous and overlap guarded.
4. Interrupted AVAudioRecorder WAV files are repaired from actual RIFF chunk data before recovery.
5. Failed cloud-note jobs with durable server job IDs are polled again after a bounded cooldown.
6. Multiple recovered meeting packets are processed serially to protect Expo SQLite transactions.
7. Gemini Interactions response schemas are reduced to the provider-supported subset, followed by strict local validation.
8. iOS-specific Help and Diagnostics copy no longer promises Android-only behavior.
9. Provider Markdown is normalized only for display; canonical notes remain unchanged for copy, export, corrections, and MKC lineage.

## Honest boundaries

- The staging iPhone has a manually verified Qwen model pack. A public fresh-install downloader is not implemented.
- This pass qualified twelve minutes and one native chunk rollover, not a literal two- or three-hour recording.
- Generic Bluetooth clicker, Back Tap, and Action Button triggers are not implemented on iOS. Recording is currently controlled in-app.
- Physical USB/Bluetooth microphone switching was not exercised in this overnight iPhone pass.
- Speaker enrollment and reliable `You` versus `Others` diarization are not implemented.
- iOS cannot guarantee unlimited post-recording CPU execution while fully suspended. Durable audio and relaunch recovery are the reliability boundary.
- MKC semantic enrichment separately observed a free Workers AI quota event and an idempotency conflict. This did not block recording, ASR, notes, or source sync and belongs to MKC hardening.

## Reproducible local release

Use `scripts/build-install-ios-staging.sh`. It pins the qualified USB iPhone 15,
Node 24, external DerivedData, version/build parity, signing verification, and
an 8 GB disk-space preflight. When no Sentry CLI token is present it skips only
the local debug-symbol upload; runtime Sentry remains compiled into the app.
