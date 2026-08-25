# ADR 0006 — Durable development observability

Status: **Accepted for v0.8.0 source candidate** · Date: 2026-08-18

## Context

Maina is still a private development build. The owner needs failures diagnosed from evidence without copying a large in-app log, while multi-hour source audio must never be deleted merely because the JavaScript process exited or the network disappeared.

The v0.7 logger was useful but volatile. A direct JavaScript-to-Supabase request could be lost when Android killed the process, and uncompressed WAV is too large for a dependable development upload path.

## Decision

Use three deliberately separate layers:

1. The existing structured logger creates scrubbed events.
2. A native SQLite outbox owns delivery state and survives React Native/process restarts.
3. Android WorkManager uploads append-only telemetry and compressed artifacts to Supabase when connected.

Audio is encoded locally as 32 kbps Opus/Ogg, with AAC-LC as a device-codec fallback. The original WAV remains the recovery source until all audio artifacts and a non-empty transcript artifact for that meeting are uploaded and its final run row is accepted. Only then may the native worker delete local source files. A periodic connected-device worker deletes remote artifacts after seven days.

Event, run and artifact IDs are deterministic or client-generated, and Supabase inserts use conflict-ignore semantics, making retries idempotent. The APK has only the publishable key. RLS permits anonymous inserts but no reads or table updates. The private Storage bucket permits upload and timed deletion; maintainer reads use the Supabase management connection, never credentials shipped in the app.

Sentry is optional and handles crashes/ANRs when configured. Supabase remains the detailed product and recording timeline.

## Language setup

The primary recognizer stays Android's on-device service. Maina automatically provisions only `en-IN` and `hi-IN`, starts with the best installed core pack, and limits detection/switch allowlists to those two locales. “Hinglish” is code-switching between those packs, not a third downloadable model.

Model download remains an Android/Google service operation and can be deferred by the OS. Recording therefore does not deliberately block while the second core pack is being provisioned, but strict on-device recognition remains enabled.

## Consequences

- A network outage or process death no longer loses diagnostic events already accepted by the native bridge.
- Roughly 2–4 MB of compressed audio is expected per ten-minute segment instead of about 19 MB of WAV.
- Empty-transcript meetings retain their WAV by design; deletion requires a transcript safety copy.
- Remote expiry is best-effort while Maina remains installed and periodically reaches the network; server-side lifecycle automation can replace it if this development archive becomes long-lived.
- This is observability and backup plumbing, not proof that Android `SpeechRecognizer` can run flawlessly for hours. Device endurance testing is still mandatory before trusting production meetings.

## v0.8.1 hardening amendment

The worker drains all available artifacts in bounded batches, exposes and resets terminal failures on explicit user request, and records queue age/attempt state. Capture-health values come from observed `audiostart`, `audioend`, recognizer start and recognizer end events. `uploaded_segments = 0` remains a truthful run-finalization snapshot because background upload happens afterward; `diagnostic_artifacts` is the authoritative upload-completion record.

The microphone foreground service raises process importance and provides Android's required recording disclosure. It does not own `AudioRecord`; the native recorder inside `expo-speech-recognition` does. This design remains a device-test candidate rather than a guarantee of uninterrupted multi-hour capture.

## Next-build microphone observability amendment

The first Hollyland Lark M2 USB-C test proved that Android enumerates the receiver as `USB-Audio - Wireless microphone`, not that the recognizer used it. The next native diagnostics revision must observe `AudioManager.getActiveRecordingConfigurations()` after recording starts and subscribe to `AudioRecordingCallback`. It must record the active input device, audio source, client/actual format, channel count, capture effects and every route transition. A visible external receiver paired with an active built-in route is a warning.

The app must not present route forcing as guaranteed while `SpeechRecognizer` owns capture. `AudioRecord.setPreferredDevice()` and `getRoutedDevice()` are useful only when Maina owns that `AudioRecord`; preferred routing is not itself proof of actual routing. Hollyland firmware, gain and noise-cancellation strength remain vendor-side settings in LarkSound. The Lark M2 mobile receiver is mono, so two transmitters do not provide isolated speaker channels.
