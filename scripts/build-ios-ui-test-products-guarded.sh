#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$PROJECT_DIR" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]; then
  echo "iOS UI-test products are restricted to the canonical iOS worktree." >&2
  exit 78
fi

# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

IOS_UDID="${MAINA_IOS_UDID:-00008120-001E146611E2601E}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"
VERSION="$("$MAINA_IOS_NODE_BIN/node" -p "require('$PROJECT_DIR/app.json').expo.version")"
BUILD_NUMBER="$("$MAINA_IOS_NODE_BIN/node" -p "require('$PROJECT_DIR/app.json').expo.ios.buildNumber")"
ATTEMPT="${MAINA_IOS_UI_TEST_BUILD_ATTEMPT:-attempt-01}"
BUILD_ROOT="${MAINA_IOS_UI_TEST_BUILD_ROOT:-$MAINA_IOS_DERIVED_DATA_ROOT/ui-tests-$VERSION-$BUILD_NUMBER-$ATTEMPT}"

maina_require_storage_path "$BUILD_ROOT" || exit $?
case "$BUILD_ROOT" in
  "$MAINA_IOS_DERIVED_DATA_ROOT"/ui-tests-*) ;;
  *) echo "iOS UI-test build root must stay under the guarded DerivedData root." >&2; exit 78 ;;
esac
if [[ -e "$BUILD_ROOT" ]]; then
  echo "iOS UI-test build root already exists; refusing mixed or retried build state." >&2
  exit 78
fi

cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" ios
[[ -d ios/Maina.xcworkspace ]] || { echo "ios/Maina.xcworkspace is missing." >&2; exit 78; }
[[ -f ios/Maina.xcodeproj/xcshareddata/xcschemes/MainaUITests.xcscheme ]] || {
  echo "MainaUITests shared scheme is missing." >&2
  exit 78
}

maina_storage_mkdir "$BUILD_ROOT"
# Qualification-only UI-test products are never distributed and must not
# require or transmit Sentry upload credentials. Runtime Sentry integration in
# the signed Maina app remains unchanged.
export SENTRY_DISABLE_AUTO_UPLOAD=true
exec "$PROJECT_DIR/scripts/external-bin/xcodebuild" \
  -workspace ios/Maina.xcworkspace \
  -scheme MainaUITests \
  -configuration Release \
  -destination "platform=iOS,id=$IOS_UDID" \
  -derivedDataPath "$BUILD_ROOT" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  MARKETING_VERSION="$VERSION" \
  build-for-testing
