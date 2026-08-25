#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

exec "$ANDROID_HOME/platform-tools/adb" -s "$MAINA_ADB_SERIAL" "$@"
