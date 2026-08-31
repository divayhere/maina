#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
RUBY_BIN="${MAINA_IOS_RUBY_BIN:-/Users/divay/Developer/.tools/maina-ruby-3.3.9-v2/bin}"
EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final iOS commit}"
export MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_FINAL"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:?Set an absolute empty output directory for the one iOS build}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"
[[ "$TEAM_ID" == "9X4X3R4KCN" ]] || { echo "iOS candidate team must remain 9X4X3R4KCN." >&2; exit 2; }
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
[[ "${MAINA_ADMIN_CAPACITY_CLEARANCE:-}" == "approved" ]] || {
  echo "Fresh post-Android Admin capacity clearance is required before the one iOS build." >&2
  exit 2
}
[[ ! -e "$OUTPUT_DIR/build-attempted" ]] || {
  echo "iOS build already attempted for this evidence directory; retry is forbidden." >&2
  exit 75
}
mkdir -p "$OUTPUT_DIR"
: > "$OUTPUT_DIR/build-attempted"
BUILD_LOG="$OUTPUT_DIR/ios-build.log"
BUILD_ROOT="$OUTPUT_DIR/DerivedData"
export PATH="$NODE_BIN:$RUBY_BIN:$PATH"
export NODE_BINARY="$NODE_BIN/node"
export NODE_ENV=production
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_ALLOW_FAILURE=true

cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
scripts/prepare-ios-local.sh

set +e
xcodebuild -workspace ios/Maina.xcworkspace -scheme Maina -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_ROOT" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  2>&1 | tee "$BUILD_LOG"
build_status=${PIPESTATUS[0]}
set -e
if [[ "$build_status" != "0" ]]; then
  echo "iOS build failed once; preserve evidence and stop without retry." >&2
  exit "$build_status"
fi
if rg -i -q 'ENOSPC|No space left|I/O error|input/output error|CodeSign.*failed' "$BUILD_LOG"; then
  echo "iOS build log contains a storage/I/O/signing stop marker; preserve evidence and stop." >&2
  exit 1
fi

APP="$BUILD_ROOT/Build/Products/Release-iphoneos/Maina.app"
DSYM="$BUILD_ROOT/Build/Products/Release-iphoneos/Maina.app.dSYM"
[[ -d "$APP" && -d "$DSYM" ]] || { echo "Signed app or matching dSYM is missing." >&2; exit 1; }
APP_ZIP="$OUTPUT_DIR/Maina-0.10.42-24.app.zip"
DSYM_ZIP="$OUTPUT_DIR/Maina-0.10.42-24.app.dSYM.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$APP_ZIP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$DSYM" "$DSYM_ZIP"
node scripts/inspect-exact-artifact.mjs ios release/m3-m4-candidate-plan.json "$APP_ZIP" "$DSYM_ZIP" \
  > "$OUTPUT_DIR/ios-inspection.json"
node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
echo "One iOS candidate build completed. Admin audit is required before any install."
