# Personal signing renewal and data preservation

Status: **P0 — required before the next iOS build is installed**

## Objective

Renew Maina's free Apple Personal Team provisioning every week from the local
Mac without a third-party sideloading dependency and without uninstalling the
app. Preserve meetings, transcript blocks, ASR checkpoints, summaries, todos,
cloud state, recordings, capture journals, Qwen model files, preferences,
Maina's durable log, available iOS crash/resource reports, and access to the
existing Keychain-backed Maina Cloud session.

Android has no weekly certificate expiry. It still receives the shared update
safety rules: fixed application identity, fixed signing identity, exact-device
targeting, in-place replacement only, and post-install verification.

## Confirmed baseline

- iOS bundle ID: `com.divay.maina.staging`
- iOS Apple Team and App ID prefix: `9X4X3R4KCN`
- Qualified device: USB iPhone 15, CoreDevice ID
  `945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD`
- Installed audited iOS build: `0.10.28 (11)`
- Live iOS SQLite integrity check passed with 21 meetings and 692 transcript
  blocks at the audit point.
- The iOS database contains four historical absolute app-container prefixes.
  The files remain present, but absolute container UUIDs are not durable update
  identifiers and must be rebased.
- Android package: `com.divay.maina`
- Installed audited Android build: `0.10.30 (56)`
- Android's installed certificate matches the current local keystore; preserve
  that exact signer before regenerating native Android output.

Counts are evidence from the audit, not hard-coded product expectations.

## Five-test boundary

The planned five physical tests run against the already-installed binaries and
must not be delayed or altered by this TODO. Do not build or install merely to
add the renewal feature. After the five tests, incorporate their findings here
and complete this blocker before installing another iOS build.

## Required iOS implementation

### Portable recording references

- Add a tested, idempotent startup repair that rewrites stale recording folder
  and segment URIs from any historical `/Documents/` prefix to the current
  `FileSystem.documentDirectory`.
- Persist future recording references in a container-portable form, resolving
  them to an absolute URL only at filesystem/native boundaries.
- Never delete a recording because an old absolute URI is unreachable until
  the rebased current-container path has also been checked.
- Cover current, stale, malformed, missing, and already-clean references with
  unit and migration tests on both platforms.

### First-party weekly renewal command

Provide one command, expected name `npm run ios:renew-personal`, that:

1. Targets only the qualified USB iPhone 15 and rejects mirroring, wireless,
   another iPhone, or a mismatched installed bundle.
2. Reads a lightweight live snapshot and refuses to terminate Maina while a
   recording or unsafe active processing stage exists.
3. Terminates Maina only after the idle gate passes.
4. Copies the complete app data container to a private, non-Git Mac directory.
5. Copies available iOS system crash/resource reports separately.
6. Verifies SQLite integrity and records sanitized pre-install counts and file
   hashes without placing transcript or audio content in logs or Git.
7. Requests provisioning refresh through Xcode using the pinned Team, bundle,
   device, Node 24 toolchain, workspace, and Release configuration.
8. Verifies the candidate's bundle ID, version/build, Team ID, application ID,
   Keychain access groups, code signature, and profile expiry before install.
9. Uses `devicectl device install app` as an in-place replacement. It must never
   call uninstall, erase, reset, or clear-data commands.
10. Launches Maina and verifies database counts did not decrease, Qwen remains
    ready, durable logs remain present, recording URIs resolve, and Maina Cloud
    session access remains available.
11. Retains the latest two verified backups and never deletes the last known
    good backup during the same run.
12. Emits a concise success/failure report with no credentials or meeting
    content.

Backups belong under an owner-only directory outside all Git repositories, for
example `~/Library/Application Support/Maina Maintenance/Backups/`. They may
contain private meeting data and must never enter `Maina`, coordination, or
source repositories.

### Keychain boundary

Apple does not expose the SecureStore session through an app-container backup.
Preservation therefore depends on keeping the same Team/App ID prefix, bundle
ID, and Keychain access groups. The renewal command must fail closed if any of
these differ from the installed release manifest.

### Failure and rollback rules

- A build, signing, backup, integrity, identity, or idle-state failure stops
  before installation.
- An installation/postflight failure preserves both the Mac backup and the
  previous signed app artifact for diagnosis and controlled recovery.
- Never attempt automatic destructive rollback.
- If Apple requests account or trust confirmation, stop and request that one
  physical action rather than changing identities.

## Required Android parity

- Copy the exact current Android signing keystore from generated native output
  into a protected local signing location outside Git; pin its certificate and
  file fingerprints in a sanitized release manifest.
- Make future release builds use that preserved signer. Do not silently create
  or substitute another key.
- Add a deterministic install command that targets only the configured USB
  Pixel, compares installed and candidate certificate fingerprints, and uses
  `adb install -r` only.
- Never use `adb uninstall`, `pm clear`, or a clean install for ordinary updates.
- Keep Android `allowBackup: false`; do not trade meeting privacy for automatic
  Google/device backup.
- Add sanitized pre/post version, package, signer, process, model-readiness, and
  app-health evidence. A future explicit encrypted local export may provide a
  stronger Android rollback boundary, but it is not a reason to enable cloud
  backup.

## Acceptance gates before the next installation

- The five planned physical tests are complete and relevant findings are
  incorporated.
- Portable-path migration tests pass and an upgrade fixture with multiple old
  iOS container UUIDs resolves its retained recordings.
- A dry-run renewal performs all checks without installing.
- A disposable-fixture renewal preserves database rows, logs, model readiness,
  Keychain session access, and filesystem references.
- One real in-place iPhone 15 renewal succeeds before the old profile expires.
- The app launches without re-pairing and all retained meeting metadata remains
  visible.
- Android's current signer is durably preserved and its update verifier rejects
  signer/package/device mismatches.
- Full mobile typecheck, tests, lint, native verifier, and release gates pass.
- No MKC endpoint, payload, prompt, provider, source-key, sync, or ownership
  contract changes are introduced.

## Sunday operating procedure after qualification

1. Connect and unlock the iPhone 15 over USB and keep the Mac online.
2. Confirm Maina is not recording; the command independently verifies this.
3. Run `npm run ios:renew-personal` before the current profile expires.
4. Review the final green data/signing/session report.
5. Do not renew Android unless an actual Android release is being installed.
