#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"
ADB="$ANDROID_HOME/platform-tools/adb"
BUILD_TOOLS="$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT="$BUILD_TOOLS/aapt"
PACKAGE_NAME="${MAINA_ANDROID_PACKAGE:-com.divay.maina}"
APK="${1:-}"
MODE="${2:-}"
[[ -f "$APK" ]] || { echo "Usage: npm run android:install-preserving -- /absolute/path.apk [--dry-run]" >&2; exit 1; }
[[ -z "$MODE" || "$MODE" == "--dry-run" ]] || { echo "Unknown installer option: $MODE" >&2; exit 1; }

PROVENANCE="${MAINA_RELEASE_PROVENANCE:?Set MAINA_RELEASE_PROVENANCE to the Admin-approved dual-platform provenance}"
node "$PROJECT_DIR/scripts/release-provenance-cli.mjs" authorize android \
  "$PROJECT_DIR/release/m3-m4-0.10.47-candidate-plan.json" "$PROVENANCE" "$APK"

candidate_sha256="$(shasum -a 256 "$APK" | awk '{print $1}')"
safe_device="$(printf '%s' "$MAINA_DEVICE_SERIAL" | tr -cd 'A-Za-z0-9._-')"
safe_package="$(printf '%s' "$PACKAGE_NAME" | tr -cd 'A-Za-z0-9._-')"
[[ -n "$safe_device" && -n "$safe_package" ]] || { echo "Installer lock identity is invalid." >&2; exit 1; }
LOCK_ROOT="${MAINA_INSTALL_LOCK_ROOT:-${TMPDIR:-/tmp}/maina-android-install-locks}"
LOCK_DIR="$LOCK_ROOT/${safe_device}--${safe_package}"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maina-android-install.XXXXXX")"
lock_acquired=0
terminal_reconciled=0

write_lock_state() {
  local outcome="$1"
  [[ "$lock_acquired" == "1" && -d "$LOCK_DIR" ]] || return 0
  {
    printf 'pid=%s\n' "$$"
    printf 'device=%s\n' "$MAINA_DEVICE_SERIAL"
    printf 'package=%s\n' "$PACKAGE_NAME"
    printf 'candidate_sha256=%s\n' "$candidate_sha256"
    printf 'outcome=%s\n' "$outcome"
  } > "$LOCK_DIR/state"
}

on_exit() {
  local status=$?
  if [[ "$lock_acquired" == "1" && "$terminal_reconciled" != "1" ]]; then
    write_lock_state "reconciliation_required"
    echo "Android install outcome is not fully reconciled; the single-flight lock was retained: $LOCK_DIR" >&2
  fi
  if [[ -d "$RUN_DIR" ]]; then
    rm -R -- "$RUN_DIR"
  fi
  return "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

mkdir -p "$LOCK_ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another Android install is running or has an unknown outcome for this device/package." >&2
  [[ -f "$LOCK_DIR/state" ]] && sed -n 's/^\(pid\|device\|package\|candidate_sha256\|outcome\)=/  \1=/p' "$LOCK_DIR/state" >&2
  echo "Resume/poll the existing execution or explicitly reconcile it; do not reinvoke adb install." >&2
  exit 75
fi
lock_acquired=1
write_lock_state "running"

[[ "$MAINA_ADB_SERIAL" == *"._adb-tls-connect._tcp" ]] || {
  echo "Configured Android target is not a Wi-Fi ADB endpoint: $MAINA_ADB_SERIAL" >&2
  exit 1
}
device_line="$($ADB devices -l | awk -v serial="$MAINA_ADB_SERIAL" '$1 == serial && $2 == "device" {print}')"
[[ -n "$device_line" ]] || {
  echo "Configured Wi-Fi Pixel is not connected: $MAINA_ADB_SERIAL" >&2
  exit 1
}
actual_endpoint="$(awk '{print $1}' <<<"$device_line")"
hardware_serial="$($ADB -s "$MAINA_ADB_SERIAL" shell getprop ro.serialno | tr -d '\r')"
model="$($ADB -s "$MAINA_ADB_SERIAL" shell getprop ro.product.model | tr -d '\r')"
[[ "$hardware_serial" == "$MAINA_DEVICE_SERIAL" && "$model" == "Pixel 9 Pro" ]] || {
  echo "Wi-Fi target identity mismatch: serial=$hardware_serial model=$model" >&2
  exit 1
}
installed_package_line="$($ADB -s "$MAINA_ADB_SERIAL" shell pm list packages "$PACKAGE_NAME" | tr -d '\r')"
[[ "$installed_package_line" == "package:$PACKAGE_NAME" ]] || {
  echo "Installed package mismatch or missing: $PACKAGE_NAME" >&2
  exit 1
}

candidate_badging="$($AAPT dump badging "$APK")"
candidate_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$candidate_badging")"
candidate_version_code="$(sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" <<<"$candidate_badging")"
candidate_version_name="$(sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" <<<"$candidate_badging")"
candidate_signer="$($APKSIGNER verify --print-certs "$APK" | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}')"

inspect_installed() {
  local output_apk="$1"
  local installed_path package_dump
  installed_path="$($ADB -s "$MAINA_ADB_SERIAL" shell pm path "$PACKAGE_NAME" | head -1 | cut -d: -f2 | tr -d '\r')"
  $ADB -s "$MAINA_ADB_SERIAL" pull "$installed_path" "$output_apk" >/dev/null
  package_dump="$($ADB -s "$MAINA_ADB_SERIAL" shell dumpsys package "$PACKAGE_NAME" | tr -d '\r')"
  INSTALLED_SHA256="$(shasum -a 256 "$output_apk" | awk '{print $1}')"
  INSTALLED_SIGNER="$($APKSIGNER verify --print-certs "$output_apk" | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}')"
  INSTALLED_VERSION_CODE="$(sed -n 's/^[[:space:]]*versionCode=\([0-9][0-9]*\).*/\1/p' <<<"$package_dump" | head -1)"
  INSTALLED_VERSION_NAME="$(sed -n 's/^[[:space:]]*versionName=\(.*\)/\1/p' <<<"$package_dump" | head -1)"
}

inspect_installed "$RUN_DIR/installed-before.apk"
installed_package="${installed_package_line#package:}"
node --input-type=module - "$actual_endpoint" "$MAINA_ADB_SERIAL" "$MAINA_DEVICE_SERIAL" "$hardware_serial" "$model" "$PACKAGE_NAME" "$installed_package" "$candidate_package" "$INSTALLED_SIGNER" "$candidate_signer" <<'NODE'
import { validateAndroidUpdate } from './scripts/lib/renewal-core.mjs';
const [
  , , serial, expectedSerial, expectedHardwareSerial, hardwareSerial, model,
  expectedPackageName, installedPackageName, candidatePackageName,
  installedSigner, candidateSigner,
] = process.argv;
validateAndroidUpdate({
  serial,
  expectedSerial,
  connection: 'wifi-adb',
  hardwareSerial,
  expectedHardwareSerial,
  model,
  expectedModel: 'Pixel 9 Pro',
  installedPackageName,
  candidatePackageName,
  expectedPackageName,
  installedSigner,
  candidateSigner,
});
console.log('Android device, package, and signer match.');
NODE

if [[ "$MODE" == "--dry-run" ]]; then
  terminal_reconciled=1
  rm -R -- "$LOCK_DIR"
  lock_acquired=0
  echo "Dry run passed. No Android install was performed."
  exit 0
fi

if [[ "$INSTALLED_SHA256" == "$candidate_sha256" \
  && "$INSTALLED_VERSION_CODE" == "$candidate_version_code" \
  && "$INSTALLED_VERSION_NAME" == "$candidate_version_name" ]]; then
  terminal_reconciled=1
  rm -R -- "$LOCK_DIR"
  lock_acquired=0
  echo "Approved Android artifact is already installed; no package update was performed."
  exit 0
fi

set +e
$ADB -s "$MAINA_ADB_SERIAL" install -r "$APK"
install_status=$?
set -e
if [[ "$install_status" != "0" ]]; then
  write_lock_state "adb_terminal_failure"
  exit "$install_status"
fi

inspect_installed "$RUN_DIR/installed-after.apk"
node --input-type=module - "$candidate_sha256" "$INSTALLED_SHA256" "$candidate_signer" "$INSTALLED_SIGNER" "$candidate_version_code" "$INSTALLED_VERSION_CODE" "$candidate_version_name" "$INSTALLED_VERSION_NAME" <<'NODE'
import { validateInstalledAndroidArtifact } from './scripts/lib/renewal-core.mjs';
const [
  , , candidateSha256, installedSha256, candidateSigner, installedSigner,
  candidateVersionCode, installedVersionCode, candidateVersionName, installedVersionName,
] = process.argv;
validateInstalledAndroidArtifact({
  candidateSha256,
  installedSha256,
  candidateSigner,
  installedSigner,
  candidateVersionCode,
  installedVersionCode,
  candidateVersionName,
  installedVersionName,
});
NODE

write_lock_state "installed_and_reconciled"
terminal_reconciled=1
rm -R -- "$LOCK_DIR"
lock_acquired=0
echo "Android in-place update installed once and reconciled with retained app data."
