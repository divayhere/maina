#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"

"$MAINA_NODE_BIN/node" "$PROJECT_DIR/scripts/verify-external-storage-contract.mjs"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" android
"$MAINA_NODE_BIN/node" "$PROJECT_DIR/coordination/scripts/verify.mjs"
"$PROJECT_DIR/scripts/ensure-gradle.sh"

cd "$PROJECT_DIR/android"
"$MAINA_GRADLE_HOME/bin/gradle" \
  --gradle-user-home "$MAINA_GRADLE_USER_HOME" \
  --project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE" \
  -PreactNativeArchitectures="$MAINA_ANDROID_ABI" \
  :maina-recorder:testDebugUnitTest \
  :maina-recorder:compileDebugKotlin \
  :app:compileDebugKotlin \
  --console=plain \
  --no-daemon
