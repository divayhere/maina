#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${MAINA_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
EXPO_CLI="${MAINA_EXPO_CLI:-$PROJECT_DIR/node_modules/expo/bin/cli}"
[[ -x "$NODE_BIN/node" ]] || { echo "Pinned Node runtime is unavailable." >&2; exit 2; }
[[ "$EXPO_CLI" == /* && -f "$EXPO_CLI" && ! -L "$EXPO_CLI" && -x "$EXPO_CLI" ]] || {
  echo "Pinned Expo CLI is unavailable." >&2
  exit 2
}
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"

cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
node scripts/verify-build-source-state.mjs android "${MAINA_EXPECTED_FINAL_COMMIT:?Set MAINA_EXPECTED_FINAL_COMMIT to the Admin-reviewed Android pin}"
"$NODE_BIN/node" "$EXPO_CLI" prebuild --platform android --no-install --clean
"$PROJECT_DIR/scripts/restore-external-build-links.sh" android
node scripts/verify-android-config.mjs
