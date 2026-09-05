#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXPECTED_FINAL="${MAINA_EXPECTED_FINAL_COMMIT:?Set the exact Admin-reviewed final Android commit}"
STORAGE_GUARD="/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh"
STORAGE_GUARD_SHA256="e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f"
[[ -x "$STORAGE_GUARD" && "$(shasum -a 256 "$STORAGE_GUARD" | awk '{print $1}')" == "$STORAGE_GUARD_SHA256" ]] || {
  echo "Canonical Maina storage guard is unavailable or changed." >&2
  exit 78
}
STORAGE_ROOT="$($STORAGE_GUARD)" || exit $?
[[ "$STORAGE_ROOT" == "/Volumes/DivaySSD/MainaBuild" ]] || { echo "Canonical Maina storage root was rejected." >&2; exit 78; }
MAINA_RELEASE_OUTPUT_ROOT="${MAINA_RELEASE_OUTPUT_ROOT:-$STORAGE_ROOT/artifacts/apps/android-main}"
OUTPUT_DIR="${MAINA_RELEASE_OUTPUT_DIR:-$MAINA_RELEASE_OUTPUT_ROOT/android/Maina-0.10.51-77-candidate}"
[[ "$OUTPUT_DIR" == /* ]] || { echo "MAINA_RELEASE_OUTPUT_DIR must be absolute." >&2; exit 2; }
case "$OUTPUT_DIR" in
  "$STORAGE_ROOT"/*) ;;
  *) echo "Android evidence output escapes the guarded external root." >&2; exit 78 ;;
esac
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

NODE_BIN="${MAINA_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
[[ -x "$NODE_BIN/node" ]] || { echo "Android qualification Node runtime is unavailable." >&2; exit 2; }
MAINA_EXPECTED_FINAL_COMMIT="$EXPECTED_FINAL" "$NODE_BIN/node" \
  "$PROJECT_DIR/scripts/qualification/android-lane.mjs" preflight >/dev/null

# Build/cache helpers may create external directories only after the complete
# side-effect-free qualification preflight has passed.
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"
maina_require_storage_path "$OUTPUT_DIR" || exit $?
cd "$PROJECT_DIR"
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
maina_storage_mkdir "$OUTPUT_DIR"
BUILD_LOG="$OUTPUT_DIR/android-build.log"
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
    echo "Android build outcome is ambiguous; the mutation lock was retained for explicit reconciliation." >&2
  fi
  return "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another Android build is active or has an unresolved outcome." >&2
  exit 75
fi
lock_acquired=1
write_lock_state "mutation_started"
: > "$OUTPUT_DIR/build-attempted"

set +e
(
  set -e
  "$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
  scripts/ensure-gradle.sh
  scripts/prebuild-android.sh
  node scripts/verify-generated-native-release-metadata.mjs android
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
  fail_terminal "ANDROID_BUILD_TERMINAL_FAILURE" "$build_status"
fi
if rg -i -q 'ENOSPC|No space left|I/O error|input/output error' "$BUILD_LOG"; then
  fail_terminal "ANDROID_BUILD_STORAGE_FAILURE" 1
fi

APK="$MAINA_ANDROID_OUTPUT_ROOT/_app/outputs/apk/release/app-release.apk"
[[ -n "$APK" && -f "$APK" ]] || fail_terminal "ANDROID_BUILD_ARTIFACT_MISSING" 1
HELD_APK="$OUTPUT_DIR/Maina-0.10.51-77.apk"
cp "$APK" "$HELD_APK"
node scripts/inspect-exact-artifact.mjs android release/m3-m4-0.10.51-candidate-plan.json "$HELD_APK" \
  > "$OUTPUT_DIR/android-inspection.json"
node scripts/verify-generated-native-release-metadata.mjs android
node scripts/verify-build-source-state.mjs android "$EXPECTED_FINAL"
release_lock "terminal_success"
echo "One Android candidate build completed. Admin audit is required before any iOS build or install."
