#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

[[ "$MAINA_ADB_SERIAL" == *"._adb-tls-connect._tcp" ]] || {
  echo "Refusing non-Wi-Fi Android target: $MAINA_ADB_SERIAL" >&2
  exit 1
}

hardware_serial="$("$ANDROID_HOME/platform-tools/adb" -s "$MAINA_ADB_SERIAL" shell getprop ro.serialno | tr -d '\r')"
[[ "$hardware_serial" == "$MAINA_DEVICE_SERIAL" ]] || {
  echo "Android target identity mismatch: $hardware_serial" >&2
  exit 1
}

exec "$ANDROID_HOME/platform-tools/adb" -s "$MAINA_ADB_SERIAL" "$@"
