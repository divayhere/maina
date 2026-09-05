#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
DEVICE_ID="${MAINA_IOS_DEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
DEVICE_UDID="${MAINA_IOS_DEVICE_UDID:-00008120-001E146611E2601E}"
BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
APP_ZIP="${1:-}"
EXPECTED_TOOLING="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact independently accepted P0H-04 tooling commit}"
PROVENANCE="${MAINA_RELEASE_PROVENANCE:?Set MAINA_RELEASE_PROVENANCE to the Admin-approved dual-platform provenance}"
[[ -f "$APP_ZIP" ]] || { echo "Usage: npm run ios:install-preserving -- /absolute/Maina.app.zip" >&2; exit 2; }
[[ "$APP_ZIP" == /* ]] || { echo "iOS candidate path must be absolute." >&2; exit 2; }
export PATH="$NODE_BIN:$PATH"
umask 077

cd "$PROJECT_DIR"
if ! node scripts/release-provenance-cli.mjs authorize ios \
  release/m3-m4-0.10.51-candidate-plan.json "$PROVENANCE" "$APP_ZIP" >/dev/null 2>&1; then
  echo "IOS_RELEASE_PROVENANCE_REJECTED" >&2
  exit 1
fi
IFS=$'\t' read -r _ _ _ EXPECTED_BUNDLE_ID EXPECTED_VERSION EXPECTED_BUILD \
  <<< "$(node scripts/release-provenance-cli.mjs replay-config release/m3-m4-0.10.51-candidate-plan.json "$PROVENANCE")"
[[ "$BUNDLE_ID" == "$EXPECTED_BUNDLE_ID" ]] || {
  echo "iOS bundle override conflicts with the approved dual provenance." >&2
  exit 2
}

MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_TOOLING" node \
  "$PROJECT_DIR/scripts/qualification/ios-lane.mjs" preflight >/dev/null

candidate_sha256="$(shasum -a 256 "$APP_ZIP" | awk '{print $1}')"
lock_identity="$(printf '%s\n%s\n' "$DEVICE_UDID" "$BUNDLE_ID" | shasum -a 256 | awk '{print $1}')"
LOCK_ROOT="${MAINA_INSTALL_LOCK_ROOT:-${TMPDIR:-/tmp}/maina-ios-install-locks}"
LOCK_DIR="$LOCK_ROOT/$lock_identity"
RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maina-ios-install.XXXXXX")"
lock_acquired=0
terminal_reconciled=0
mutation_started=0

write_lock_state() {
  local phase="$1" outcome="$1"
  [[ "$lock_acquired" == "1" && -d "$LOCK_DIR" ]] || return 0
  [[ "$phase" != "mutation_started" ]] || outcome="running"
  printf 'candidate_sha256=%s\nphase=%s\noutcome=%s\n' "$candidate_sha256" "$phase" "$outcome" > "$LOCK_DIR/state"
}
on_exit() {
  local status=$?
  if [[ "$lock_acquired" == "1" && "$mutation_started" == "1" && "$terminal_reconciled" != "1" ]]; then
    write_lock_state "reconciliation_required"
    echo "iOS install outcome is ambiguous; the mutation lock was retained for explicit reconciliation." >&2
  elif [[ "$lock_acquired" == "1" ]]; then
    rm -R -- "$LOCK_DIR"
    lock_acquired=0
  fi
  [[ ! -d "$RUN_ROOT" ]] || rm -R -- "$RUN_ROOT"
  return "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if [[ -e "$LOCK_DIR" ]]; then
  echo "Another iOS install is running or has an unreconciled outcome." >&2
  exit 75
fi

CAPABILITY_STARTED_MS="$(node -p 'Date.now()')"
if ! xcrun devicectl device info processes --device "$DEVICE_ID" --timeout 15 --quiet >/dev/null 2>&1; then
  echo "IOS_DEVICE_CAPABILITY_UNAVAILABLE" >&2
  exit 1
fi
CAPABILITY_COMPLETED_MS="$(node -p 'Date.now()')"
if ! xcrun devicectl list devices --json-output "$RUN_ROOT/devices.json" --quiet >/dev/null 2>&1 \
  || ! xcrun devicectl device info apps --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" --columns '*' \
    --json-output "$RUN_ROOT/apps-before.json" --quiet >/dev/null 2>&1; then
  echo "IOS_DEVICE_IDENTITY_UNAVAILABLE" >&2
  exit 1
fi
if ! node --input-type=module - "$RUN_ROOT/devices.json" "$RUN_ROOT/apps-before.json" "$DEVICE_ID" "$DEVICE_UDID" "$BUNDLE_ID" "$CAPABILITY_STARTED_MS" "$CAPABILITY_COMPLETED_MS" >/dev/null 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
import { findInstalledIosApp, findQualifiedIosDevice } from './scripts/lib/renewal-core.mjs';
const [, , devicesPath, appsPath, deviceId, udid, bundleId, startedAtMs, completedAtMs] = process.argv;
const proof = {
  schemaVersion: 'maina.ios-coredevice-capability-proof.v1', deviceId,
  operation: 'device-info-processes', timeoutMs: 15_000,
  startedAtMs: Number(startedAtMs), completedAtMs: Number(completedAtMs), exitCode: 0,
};
findQualifiedIosDevice(JSON.parse(readFileSync(devicesPath)), { deviceId, udid, marketingName: 'iPhone 15', nowMs: Date.now() }, proof);
findInstalledIosApp(JSON.parse(readFileSync(appsPath)), bundleId);
NODE
then
  echo "IOS_DEVICE_IDENTITY_REJECTED" >&2
  exit 1
fi

if ! xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" --source / --destination "$RUN_ROOT/preflight-container" --quiet >/dev/null 2>&1 \
  || ! node scripts/inspect-mobile-backup.mjs "$RUN_ROOT/preflight-container" > "$RUN_ROOT/before.json" 2>/dev/null; then
  echo "IOS_DATA_PRESERVATION_PREFLIGHT_FAILED" >&2
  exit 1
fi
if ! node --input-type=module - "$RUN_ROOT/before.json" >/dev/null 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
const snapshot = JSON.parse(readFileSync(process.argv[2]));
if (snapshot.activeRecordings > 0) throw new Error('Maina is actively recording; install refused.');
NODE
then
  echo "IOS_ACTIVE_RECORDING_BLOCKS_INSTALL" >&2
  exit 1
fi

if ! /usr/bin/ditto -x -k "$APP_ZIP" "$RUN_ROOT/candidate" >/dev/null 2>&1; then
  echo "IOS_CANDIDATE_ARCHIVE_REJECTED" >&2
  exit 1
fi
APP="$(find "$RUN_ROOT/candidate" -maxdepth 2 -type d -name '*.app' | head -n 1)"
[[ -n "$APP" && -d "$APP" ]] || { echo "Approved app ZIP does not contain an app." >&2; exit 1; }
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist" 2>/dev/null)" == "$BUNDLE_ID" ]] || {
  echo "Approved app bundle identifier mismatch." >&2
  exit 1
}

# Exactly one in-place install call. No destructive package/data command or
# pre-install termination is used; ambiguity retains the lock and forbids reinvocation.
mkdir -p "$LOCK_ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another iOS install is running or has an unreconciled outcome." >&2
  exit 75
fi
lock_acquired=1
write_lock_state "mutation_started"
mutation_started=1
set +e
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" > "$RUN_ROOT/install-output.txt" 2>&1
install_status=$?
set -e
if [[ "$install_status" != "0" ]]; then
  echo "IOS_INSTALL_OUTCOME_AMBIGUOUS" >&2
  exit "$install_status"
fi
if ! xcrun devicectl device info apps --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" --columns '*' \
  --json-output "$RUN_ROOT/apps-after.json" --quiet >/dev/null 2>&1; then
  echo "IOS_INSTALL_RECONCILIATION_UNAVAILABLE" >&2
  exit 1
fi
if ! node --input-type=module - "$RUN_ROOT/apps-after.json" "$EXPECTED_BUNDLE_ID" "$EXPECTED_VERSION" "$EXPECTED_BUILD" >/dev/null 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
import { findInstalledIosApp, validateInstalledIosArtifact } from './scripts/lib/renewal-core.mjs';
const [, , appsPath, bundleId, version, build] = process.argv;
const installed = findInstalledIosApp(JSON.parse(readFileSync(appsPath)), bundleId);
validateInstalledIosArtifact(installed, { bundleId, version, build });
NODE
then
  echo "IOS_INSTALLED_IDENTITY_REJECTED" >&2
  exit 1
fi
if ! xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" >/dev/null 2>&1 \
  || ! xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer \
    --domain-identifier "$BUNDLE_ID" --source / --destination "$RUN_ROOT/postflight-container" --quiet >/dev/null 2>&1 \
  || ! node scripts/inspect-mobile-backup.mjs "$RUN_ROOT/postflight-container" > "$RUN_ROOT/after.json" 2>/dev/null \
  || ! node scripts/validate-renewal-snapshots.mjs "$RUN_ROOT/before.json" "$RUN_ROOT/after.json" >/dev/null 2>&1; then
  echo "IOS_DATA_PRESERVATION_RECONCILIATION_FAILED" >&2
  exit 1
fi
write_lock_state "installed_and_reconciled"
terminal_reconciled=1
rm -R -- "$LOCK_DIR"
lock_acquired=0
echo "iOS in-place update installed once and reconciled with retained app data."
