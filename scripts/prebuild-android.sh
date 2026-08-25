#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

cd "$PROJECT_DIR"
npx expo prebuild --platform android --no-install
node scripts/verify-android-config.mjs
