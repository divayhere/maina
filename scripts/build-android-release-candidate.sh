#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies

EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final Android commit}"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:-$MAINA_RELEASE_OUTPUT_ROOT/android/Maina-0.10.47-73-candidate}"
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
maina_require_storage_path "$OUTPUT_DIR" || exit $?
case "$OUTPUT_DIR" in
  "$MAINA_RELEASE_OUTPUT_ROOT"/android/*) ;;
  *) echo "MAINA_RELEASE_OUTPUT_DIR must stay under the guarded Android artifact root." >&2; exit 78 ;;
esac
[[ "${MAINA_ADMIN_CAPACITY_CLEARANCE:-}" == "approved" ]] || {
  echo "Fresh Admin capacity clearance is required before the one Android build." >&2
  exit 2
}
[[ ! -e "$OUTPUT_DIR/build-attempted" ]] || {
  echo "Android build already attempted for this evidence directory; retry is forbidden." >&2
  exit 75
}
if [[ -e "$OUTPUT_DIR" && ! -d "$OUTPUT_DIR" ]]; then
  echo "Android evidence output path exists and is not a directory." >&2
  exit 2
fi
if [[ -d "$OUTPUT_DIR" && -n "$(find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Android evidence output directory is not fresh; refusing to mix prior evidence with a new attempt." >&2
  exit 73
fi
maina_storage_mkdir "$OUTPUT_DIR"
: > "$OUTPUT_DIR/build-attempted"
BUILD_LOG="$OUTPUT_DIR/android-build.log"

cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
scripts/ensure-gradle.sh
scripts/prebuild-android.sh
node scripts/verify-generated-native-release-metadata.mjs android

set +e
(
  set -e
  cd android
  gradle_args=(
    --gradle-user-home "$GRADLE_USER_HOME"
    --project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE"
    -PreactNativeArchitectures="$MAINA_ANDROID_ABI"
    --console=plain --no-daemon
  )
  "$MAINA_GRADLE_HOME/bin/gradle" "${gradle_args[@]}" clean
  "$PROJECT_DIR/scripts/restore-external-build-links.sh" android
  "$MAINA_GRADLE_HOME/bin/gradle" "${gradle_args[@]}" :app:assembleRelease
) 2>&1 | tee "$BUILD_LOG"
build_status=${PIPESTATUS[0]}
set -e
if [[ "$build_status" != "0" ]]; then
  echo "Android build failed once; preserve evidence and stop without retry." >&2
  exit "$build_status"
fi
if rg -i -q 'ENOSPC|No space left|I/O error|input/output error' "$BUILD_LOG"; then
  echo "Android build log contains a storage/I/O stop marker; preserve evidence and stop." >&2
  exit 1
fi

APK="$MAINA_ANDROID_OUTPUT_ROOT/_app/outputs/apk/release/app-release.apk"
[[ -n "$APK" && -f "$APK" ]] || { echo "Exact release APK was not produced." >&2; exit 1; }
HELD_APK="$OUTPUT_DIR/Maina-0.10.47-73.apk"
cp "$APK" "$HELD_APK"
node scripts/inspect-exact-artifact.mjs android release/m3-m4-0.10.47-candidate-plan.json "$HELD_APK" \
  > "$OUTPUT_DIR/android-inspection.json"
node scripts/verify-generated-native-release-metadata.mjs android
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
echo "One Android candidate build completed. Admin audit is required before any iOS build or install."
