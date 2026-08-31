#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs android "${MAINA_EXPECTED_FINAL_COMMIT:?Set MAINA_EXPECTED_FINAL_COMMIT to the Admin-reviewed Android pin}"
npx expo prebuild --platform android --no-install --clean
node scripts/verify-android-config.mjs
