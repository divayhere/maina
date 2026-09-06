#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$PROJECT_DIR" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]; then
  echo "iOS UI tests are restricted to the canonical iOS worktree." >&2
  exit 78
fi

# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

IOS_UDID="${MAINA_IOS_UDID:-00008120-001E146611E2601E}"
VERSION="$("$MAINA_IOS_NODE_BIN/node" -p "require('$PROJECT_DIR/app.json').expo.version")"
BUILD_NUMBER="$("$MAINA_IOS_NODE_BIN/node" -p "require('$PROJECT_DIR/app.json').expo.ios.buildNumber")"
PRODUCTS_ATTEMPT="${MAINA_IOS_UI_TEST_PRODUCTS_ATTEMPT:?set the already-built UI-test products attempt}"
RUN_ATTEMPT="${MAINA_IOS_UI_TEST_RUN_ATTEMPT:?set a fresh UI-test run attempt}"
PRODUCTS_ROOT="$MAINA_IOS_DERIVED_DATA_ROOT/ui-tests-$VERSION-$BUILD_NUMBER-$PRODUCTS_ATTEMPT"
RESULT_ROOT="$MAINA_IOS_DERIVED_DATA_ROOT/ui-test-results-$VERSION-$BUILD_NUMBER-$RUN_ATTEMPT"

maina_require_storage_path "$PRODUCTS_ROOT" || exit $?
maina_require_storage_path "$RESULT_ROOT" || exit $?
case "$PRODUCTS_ROOT" in
  "$MAINA_IOS_DERIVED_DATA_ROOT"/ui-tests-*) ;;
  *) echo "iOS UI-test products must stay under the guarded DerivedData root." >&2; exit 78 ;;
esac
case "$RESULT_ROOT" in
  "$MAINA_IOS_DERIVED_DATA_ROOT"/ui-test-results-*) ;;
  *) echo "iOS UI-test results must stay under the guarded DerivedData root." >&2; exit 78 ;;
esac
shopt -s nullglob
XCTESTRUN_CANDIDATES=("$PRODUCTS_ROOT"/Build/Products/MainaUITests_iphoneos*-arm64.xctestrun)
shopt -u nullglob
if (( ${#XCTESTRUN_CANDIDATES[@]} != 1 )); then
  echo "Exactly one prebuilt physical-device xctestrun file is required." >&2
  exit 78
fi
XCTESTRUN="${XCTESTRUN_CANDIDATES[0]}"
[[ -f "$XCTESTRUN" ]] || { echo "The exact prebuilt xctestrun file is missing." >&2; exit 78; }
if [[ -e "$RESULT_ROOT" ]]; then
  echo "iOS UI-test result root already exists; refusing a retry or mixed evidence." >&2
  exit 78
fi

declare -a selected_tests=()
for requested_test in "$@"; do
  case "$requested_test" in
    navigation-audit)
      selected_tests+=("-only-testing:MainaUITests/MainaUITests/testNavigationAudit")
      ;;
    short-recording-lifecycle)
      selected_tests+=("-only-testing:MainaUITests/MainaUITests/testShortRecordingLifecycle")
      ;;
    *)
      echo "Unsupported iOS UI-test case: $requested_test" >&2
      exit 64
      ;;
  esac
done
if (( ${#selected_tests[@]} == 0 )); then
  echo "Select at least one approved iOS UI-test case." >&2
  exit 64
fi

maina_storage_mkdir "$RESULT_ROOT"
exec "$PROJECT_DIR/scripts/external-bin/xcodebuild" \
  test-without-building \
  -xctestrun "$XCTESTRUN" \
  -destination "platform=iOS,id=$IOS_UDID" \
  -resultBundlePath "$RESULT_ROOT/MainaUITests.xcresult" \
  "${selected_tests[@]}"
