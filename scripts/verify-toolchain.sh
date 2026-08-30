#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "$node_major" != "24" ]]; then
  echo "Expected Node 24; found $(node --version)." >&2
  exit 1
fi

java_version="$($JAVA_HOME/bin/java -version 2>&1 | sed -n '1p')"
if [[ "$java_version" != *'17.'* ]]; then
  echo "Expected JDK 17; found: $java_version" >&2
  exit 1
fi

if [[ ! -x "$MAINA_GRADLE_HOME/bin/gradle" ]]; then
  echo "Pinned Gradle is missing; run scripts/ensure-gradle.sh." >&2
  exit 1
fi
gradle_version="$($MAINA_GRADLE_HOME/bin/gradle --version | sed -n 's/^Gradle //p')"
[[ "$gradle_version" == "9.3.1" ]] || { echo "Expected Gradle 9.3.1; found $gradle_version." >&2; exit 1; }

adb="$ANDROID_HOME/platform-tools/adb"
if [[ "$MAINA_ADB_SERIAL" != *"._adb-tls-connect._tcp" ]]; then
  echo "Android target must be the pinned Wi-Fi ADB endpoint; found $MAINA_ADB_SERIAL." >&2
  exit 1
fi
if ! "$adb" devices | awk 'NR > 1 && $1 == serial && $2 == "device" { found = 1 } END { exit found ? 0 : 1 }' serial="$MAINA_ADB_SERIAL"; then
  echo "Expected Wi-Fi Pixel endpoint $MAINA_ADB_SERIAL is not connected and authorized." >&2
  exit 1
fi
hardware_serial="$("$adb" -s "$MAINA_ADB_SERIAL" shell getprop ro.serialno | tr -d '\r')"
model="$("$adb" -s "$MAINA_ADB_SERIAL" shell getprop ro.product.model | tr -d '\r')"
[[ "$hardware_serial" == "$MAINA_DEVICE_SERIAL" && "$model" == "Pixel 9 Pro" ]] || {
  echo "Wi-Fi ADB target identity mismatch: serial=$hardware_serial model=$model." >&2
  exit 1
}

printf 'Toolchain OK: Node %s, %s, Gradle %s, Wi-Fi device %s (%s)\n' \
  "$(node --version)" "$java_version" "$gradle_version" "$MAINA_ADB_SERIAL" "$model"
