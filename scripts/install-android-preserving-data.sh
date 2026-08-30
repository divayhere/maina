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
DRY_RUN="${2:-}"
[[ -f "$APK" ]] || { echo "Usage: npm run android:install-preserving -- /absolute/path.apk [--dry-run]" >&2; exit 1; }

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

installed_path="$($ADB -s "$MAINA_ADB_SERIAL" shell pm path "$PACKAGE_NAME" | head -1 | cut -d: -f2 | tr -d '\r')"
installed_copy="/tmp/maina-installed-base.apk"
$ADB -s "$MAINA_ADB_SERIAL" pull "$installed_path" "$installed_copy" >/dev/null
installed_signer="$($APKSIGNER verify --print-certs "$installed_copy" | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}')"
candidate_signer="$($APKSIGNER verify --print-certs "$APK" | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}')"
candidate_package="$($AAPT dump badging "$APK" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
installed_package="${installed_package_line#package:}"
node --input-type=module - "$actual_endpoint" "$MAINA_ADB_SERIAL" "$MAINA_DEVICE_SERIAL" "$hardware_serial" "$model" "$PACKAGE_NAME" "$installed_package" "$candidate_package" "$installed_signer" "$candidate_signer" <<'NODE'
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
if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run passed. No Android install was performed."
  exit 0
fi
$ADB -s "$MAINA_ADB_SERIAL" install -r "$APK"
echo "Android in-place update installed with retained app data."
