#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
export PATH="$NODE_BIN:$PATH"
export NODE_ENV=production

if [[ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" != "24" ]]; then
  echo "Expected Node 24; found $(node --version)." >&2
  exit 1
fi
xcodebuild -checkFirstLaunchStatus
cd "$PROJECT_DIR"
npm ci
npm run verify:ios-native
npx expo prebuild --platform ios --no-install

if command -v pod >/dev/null 2>&1; then
  (cd ios && pod install)
else
  echo "CocoaPods is not installed. Install it before native iPhone build." >&2
  exit 2
fi
