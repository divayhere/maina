#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
RUBY_BIN="${MAINA_IOS_RUBY_BIN:-/Users/divay/Developer/.tools/maina-ruby-3.3.9-v2/bin}"
export PATH="$NODE_BIN:$RUBY_BIN:$PATH"
if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  export SENTRY_DISABLE_AUTO_UPLOAD=true
fi

if [[ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" != "24" ]]; then
  echo "Expected Node 24; found $(node --version)." >&2
  exit 1
fi
xcodebuild -checkFirstLaunchStatus
if [[ "$(ruby --version)" != ruby\ 3.3.9* ]]; then
  echo "Expected the isolated Maina Ruby 3.3.9; found $(ruby --version)." >&2
  exit 1
fi
if [[ "$(pod --version)" != "1.17.0" ]]; then
  echo "Expected CocoaPods 1.17.0; found $(pod --version)." >&2
  exit 1
fi
cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs ios "${MAINA_EXPECTED_FINAL_COMMIT:?Set MAINA_EXPECTED_FINAL_COMMIT to the Admin-reviewed iOS pin}"
NODE_ENV=development npm ci
export NODE_ENV=production
npm run ios:runtime
npm run verify:ios-native
npx expo prebuild --platform ios --no-install --clean
(cd ios && pod install)
ruby scripts/configure-ios-ui-tests.rb
