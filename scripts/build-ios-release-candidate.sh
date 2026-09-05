#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies

EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final iOS commit}"
export MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_FINAL"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:-$MAINA_IOS_RELEASE_OUTPUT_ROOT/ios/Maina-0.10.48-30-candidate}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"
[[ "$TEAM_ID" == "9X4X3R4KCN" ]] || { echo "iOS candidate team must remain 9X4X3R4KCN." >&2; exit 2; }
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
maina_require_storage_path "$OUTPUT_DIR" || exit $?
case "$OUTPUT_DIR" in
  "$MAINA_IOS_RELEASE_OUTPUT_ROOT"/ios/*) ;;
  *) echo "MAINA_RELEASE_OUTPUT_DIR must stay under the guarded iOS artifact root." >&2; exit 78 ;;
esac
[[ "${MAINA_ADMIN_CAPACITY_CLEARANCE:-}" == "approved" ]] || {
  echo "Fresh post-Android Admin capacity clearance is required before the one iOS build." >&2
  exit 2
}
[[ ! -e "$OUTPUT_DIR/build-attempted" ]] || {
  echo "iOS build already attempted for this evidence directory; retry is forbidden." >&2
  exit 75
}
if [[ -e "$OUTPUT_DIR" && ! -d "$OUTPUT_DIR" ]]; then
  echo "iOS evidence output path exists and is not a directory." >&2
  exit 2
fi
if [[ -d "$OUTPUT_DIR" && -n "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "iOS evidence output directory is not fresh; refusing to mix prior evidence with a new attempt." >&2
  exit 73
fi
BUILD_ROOT="${MAINA_IOS_CANDIDATE_DERIVED_DATA:-$MAINA_IOS_DERIVED_DATA_ROOT/Maina-0.10.48-30-candidate}"
maina_require_storage_path "$BUILD_ROOT" || exit $?
case "$BUILD_ROOT" in
  "$MAINA_IOS_DERIVED_DATA_ROOT"/*) ;;
  *) echo "iOS candidate DerivedData must stay under the guarded iOS DerivedData root." >&2; exit 78 ;;
esac
if [[ -e "$BUILD_ROOT" && ! -d "$BUILD_ROOT" ]]; then
  echo "iOS DerivedData path exists and is not a directory." >&2
  exit 2
fi
if [[ -d "$BUILD_ROOT" && -n "$(find "$BUILD_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "iOS DerivedData directory is not fresh; refusing mixed build state." >&2
  exit 73
fi
maina_storage_mkdir "$OUTPUT_DIR"
: > "$OUTPUT_DIR/build-attempted"
BUILD_LOG="$OUTPUT_DIR/ios-build.log"
export NODE_ENV=production
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_ALLOW_FAILURE=true

cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
scripts/prepare-ios-local.sh
node scripts/verify-generated-native-release-metadata.mjs ios

set +e
xcodebuild -workspace ios/Maina.xcworkspace -scheme Maina -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_ROOT" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  PODFILE_DIR="$PROJECT_DIR/ios" \
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
APP_ZIP="$OUTPUT_DIR/Maina-0.10.48-30.app.zip"
DSYM_ZIP="$OUTPUT_DIR/Maina-0.10.48-30.app.dSYM.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$APP_ZIP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$DSYM" "$DSYM_ZIP"
node scripts/inspect-exact-artifact.mjs ios release/m3-m4-0.10.48-candidate-plan.json "$APP_ZIP" "$DSYM_ZIP" \
  > "$OUTPUT_DIR/ios-inspection.json"
node scripts/verify-generated-native-release-metadata.mjs ios
node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
echo "One iOS candidate build completed. Admin audit is required before any install."
