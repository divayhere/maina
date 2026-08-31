#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final Android commit}"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:?Set an absolute empty output directory for the one Android build}"
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
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
mkdir -p "$OUTPUT_DIR"
: > "$OUTPUT_DIR/build-attempted"
BUILD_LOG="$OUTPUT_DIR/android-build.log"

cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
scripts/ensure-gradle.sh
scripts/prebuild-android.sh

set +e
(
  cd android
  "$MAINA_GRADLE_HOME/bin/gradle" \
    --gradle-user-home "$GRADLE_USER_HOME" \
    --project-cache-dir "$MAINA_BUILD_ROOT/gradle-project-cache" \
    --init-script "$PROJECT_DIR/scripts/gradle-output-redirect.init.gradle" \
    -PreactNativeArchitectures="$MAINA_ANDROID_ABI" \
    clean :app:assembleRelease --console=plain --no-daemon
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

APK="$MAINA_BUILD_ROOT/outputs/_app/outputs/apk/release/app-release.apk"
[[ -n "$APK" && -f "$APK" ]] || { echo "Exact release APK was not produced." >&2; exit 1; }
HELD_APK="$OUTPUT_DIR/Maina-0.10.42-68.apk"
cp "$APK" "$HELD_APK"
node scripts/inspect-exact-artifact.mjs android release/m3-m4-candidate-plan.json "$HELD_APK" \
  > "$OUTPUT_DIR/android-inspection.json"
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
echo "One Android candidate build completed. Admin audit is required before any iOS build or install."
