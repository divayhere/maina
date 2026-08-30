#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

# Historical command name retained for script compatibility. The resolved
# target is now strictly the pinned Wi-Fi ADB endpoint; USB is not permitted.
exec "$PROJECT_DIR/scripts/adb-target.sh" "$@"
