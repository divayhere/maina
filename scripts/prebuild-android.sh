#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"

cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
node scripts/verify-build-source-state.mjs android "${MAINA_EXPECTED_FINAL_COMMIT:?Set MAINA_EXPECTED_FINAL_COMMIT to the Admin-reviewed Android pin}"
npx expo prebuild --platform android --no-install --clean
"$PROJECT_DIR/scripts/restore-external-build-links.sh" android
node scripts/verify-android-config.mjs
