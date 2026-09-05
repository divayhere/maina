#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final iOS commit}"
export MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_FINAL"
STORAGE_GUARD="/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh"
STORAGE_GUARD_SHA256="e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f"
[[ -x "$STORAGE_GUARD" && "$(shasum -a 256 "$STORAGE_GUARD" | awk '{print $1}')" == "$STORAGE_GUARD_SHA256" ]] || {
  echo "Canonical Maina storage guard is unavailable or changed." >&2
  exit 78
}
STORAGE_ROOT="$($STORAGE_GUARD)" || exit $?
[[ "$STORAGE_ROOT" == "/Volumes/DivaySSD/MainaBuild" ]] || { echo "Canonical Maina storage root was rejected." >&2; exit 78; }
MAINA_IOS_RELEASE_OUTPUT_ROOT="${MAINA_IOS_RELEASE_OUTPUT_ROOT:-$STORAGE_ROOT/artifacts/apps/ios-feasibility}"
MAINA_IOS_DERIVED_DATA_ROOT="${MAINA_IOS_DERIVED_DATA_ROOT:-$STORAGE_ROOT/builds/apps/ios-feasibility/ios/DerivedData}"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:-$MAINA_IOS_RELEASE_OUTPUT_ROOT/ios/Maina-0.10.51-33-candidate}"
BUILD_ROOT="${MAINA_IOS_CANDIDATE_DERIVED_DATA:-$MAINA_IOS_DERIVED_DATA_ROOT/Maina-0.10.51-33-candidate}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"

[[ "$TEAM_ID" == "9X4X3R4KCN" ]] || { echo "iOS candidate team must remain 9X4X3R4KCN." >&2; exit 2; }
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
case "$OUTPUT_DIR" in
  "$STORAGE_ROOT"/*) ;;
  *) echo "iOS evidence output escapes the guarded external root." >&2; exit 78 ;;
esac
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
case "$BUILD_ROOT" in
  "$STORAGE_ROOT"/*) ;;
  *) echo "iOS candidate DerivedData escapes the guarded external root." >&2; exit 78 ;;
esac
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

NODE_BIN="${MAINA_IOS_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
[[ -x "$NODE_BIN/node" ]] || { echo "iOS qualification Node runtime is unavailable." >&2; exit 2; }
MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_FINAL" "$NODE_BIN/node" \
  "$PROJECT_DIR/scripts/qualification/ios-lane.mjs" preflight >/dev/null

# Build/cache helpers may create external directories only after the complete
# side-effect-free qualification preflight has passed.
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"
maina_require_storage_path "$OUTPUT_DIR" || exit $?
maina_require_storage_path "$BUILD_ROOT" || exit $?
maina_storage_mkdir "$OUTPUT_DIR"
BUILD_LOG="$OUTPUT_DIR/ios-build.log"
LOCK_DIR="$OUTPUT_DIR/mutation-lock"
lock_acquired=0
terminal_reconciled=0

write_lock_state() {
  local outcome="$1"
  [[ "$lock_acquired" == "1" && -d "$LOCK_DIR" ]] || return 0
  printf 'outcome=%s\n' "$outcome" > "$LOCK_DIR/state"
}

release_lock() {
  local outcome="$1"
  write_lock_state "$outcome"
  terminal_reconciled=1
  rm -R -- "$LOCK_DIR"
  lock_acquired=0
  printf 'outcome=%s\n' "$outcome" > "$OUTPUT_DIR/build-outcome"
}

fail_terminal() {
  local reason="$1" status="${2:-1}"
  release_lock "$reason"
  echo "$reason" >&2
  exit "$status"
}

on_exit() {
  local status=$?
  if [[ "$lock_acquired" == "1" && "$terminal_reconciled" != "1" ]]; then
    write_lock_state "reconciliation_required"
    echo "iOS build outcome is ambiguous; the mutation lock was retained for explicit reconciliation." >&2
  fi
  return "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another iOS build is active or has an unresolved outcome." >&2
  exit 75
fi
lock_acquired=1
write_lock_state "mutation_started"
: > "$OUTPUT_DIR/build-attempted"
export NODE_ENV=production
export SENTRY_DISABLE_AUTO_UPLOAD=true
export SENTRY_ALLOW_FAILURE=true

cd "$PROJECT_DIR"
set +e
(
  set -e
  "$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
  node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
  scripts/prepare-ios-local.sh
  node scripts/verify-generated-native-release-metadata.mjs ios
  xcodebuild -workspace ios/Maina.xcworkspace -scheme Maina -configuration Release \
    -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_ROOT" \
    -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
    PODFILE_DIR="$PROJECT_DIR/ios"
) 2>&1 | tee "$BUILD_LOG"
build_status=${PIPESTATUS[0]}
set -e
if [[ "$build_status" != "0" ]]; then
  fail_terminal "IOS_BUILD_TERMINAL_FAILURE" "$build_status"
fi
if rg -i -q 'ENOSPC|No space left|I/O error|input/output error|CodeSign.*failed' "$BUILD_LOG"; then
  fail_terminal "IOS_BUILD_STORAGE_OR_SIGNING_FAILURE" 1
fi

APP="$BUILD_ROOT/Build/Products/Release-iphoneos/Maina.app"
DSYM="$BUILD_ROOT/Build/Products/Release-iphoneos/Maina.app.dSYM"
[[ -d "$APP" && -d "$DSYM" ]] || fail_terminal "IOS_BUILD_ARTIFACT_MISSING" 1
APP_ZIP="$OUTPUT_DIR/Maina-0.10.51-33.app.zip"
DSYM_ZIP="$OUTPUT_DIR/Maina-0.10.51-33.app.dSYM.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$APP_ZIP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$DSYM" "$DSYM_ZIP"
node scripts/inspect-exact-artifact.mjs ios release/m3-m4-0.10.51-candidate-plan.json "$APP_ZIP" "$DSYM_ZIP" \
  > "$OUTPUT_DIR/ios-inspection.json"
node scripts/verify-generated-native-release-metadata.mjs ios
node scripts/verify-build-source-state.mjs ios "$EXPECTED_FINAL"
release_lock "built_and_reconciled"
echo "One iOS candidate build completed. Admin audit is required before any install."
