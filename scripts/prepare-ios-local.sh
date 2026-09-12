#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  export SENTRY_DISABLE_AUTO_UPLOAD=true
fi

NODE_EXECUTABLE="${MAINA_IOS_NODE_BIN:?Set MAINA_IOS_NODE_BIN to the verified Node directory}/node"
NPM_CLI="${MAINA_NPM_CLI:?Set MAINA_NPM_CLI to the verified npm CLI}"
EXPO_CLI="${MAINA_EXPO_CLI:?Set MAINA_EXPO_CLI to the verified project Expo wrapper}"
if [[ "$($NODE_EXECUTABLE --version)" != "v24.19.0" ]]; then
  echo "Expected Node v24.19.0; found $($NODE_EXECUTABLE --version)." >&2
  exit 1
fi
"$NODE_EXECUTABLE" "$PROJECT_DIR/scripts/verify-release-toolchain.mjs" \
  "$PROJECT_DIR" "$NODE_EXECUTABLE" "$NPM_CLI" "$EXPO_CLI" \
  "$PROJECT_DIR/release/m3-m4-0.10.70-candidate-plan.json" >/dev/null
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
"$PROJECT_DIR/scripts/install-external-node-dependencies.sh"
"$NODE_EXECUTABLE" "$PROJECT_DIR/scripts/verify-release-toolchain.mjs" \
  "$PROJECT_DIR" "$NODE_EXECUTABLE" "$NPM_CLI" "$EXPO_CLI" \
  "$PROJECT_DIR/release/m3-m4-0.10.70-candidate-plan.json" >/dev/null
export NODE_ENV=production
"$NODE_EXECUTABLE" "$NPM_CLI" run ios:runtime
"$NODE_EXECUTABLE" "$NPM_CLI" run verify:ios-native
"$NODE_EXECUTABLE" "$EXPO_CLI" prebuild --platform ios --no-install --clean
"$PROJECT_DIR/scripts/restore-external-build-links.sh" ios
(cd ios && PROJECT_ROOT="$PROJECT_DIR" pod install)
"$MAINA_IOS_RUBY_BIN/ruby" scripts/verify-ios-pod-source-membership.rb
"$PROJECT_DIR/scripts/configure-ios-ui-tests-guarded.sh"
