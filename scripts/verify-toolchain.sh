#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"

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

adb="$ANDROID_HOME/platform-tools/adb"
if ! "$adb" devices | awk 'NR > 1 && $1 == serial && $2 == "device" { found = 1 } END { exit found ? 0 : 1 }' serial="$MAINA_ADB_SERIAL"; then
  echo "Expected USB Pixel $MAINA_ADB_SERIAL is not connected and authorized." >&2
  exit 1
fi

printf 'Toolchain OK: Node %s, %s, USB device %s\n' "$(node --version)" "$java_version" "$MAINA_ADB_SERIAL"
