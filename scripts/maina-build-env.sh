#!/usr/bin/env bash
# Source this file before every local Android dependency, prebuild, or build action.

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "Maina build storage requires Bash." >&2
  return 78 2>/dev/null || exit 78
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file from a Maina build script." >&2
  exit 78
fi

MAINA_BUILD_ENV_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=maina-storage.sh
source "$MAINA_BUILD_ENV_REPO_ROOT/scripts/maina-storage.sh" || return $?

case "$MAINA_BUILD_ENV_REPO_ROOT" in
  /Users/divay/Developer/MainaV2) MAINA_STORAGE_SLOT='android-main' ;;
  /Users/divay/Developer/.worktrees/maina-ios-feasibility) MAINA_STORAGE_SLOT='ios-feasibility' ;;
  *)
    maina_storage_fail "Maina repository is not an approved canonical Apps worktree."
    return $?
    ;;
esac

MAINA_BUILD_ROOT="${MAINA_BUILD_ROOT:-/Users/divay/.cache/maina-build-v2}"
MAINA_GRADLE_USER_HOME="${MAINA_GRADLE_USER_HOME:-$MAINA_BUILD_ROOT/gradle-user-home}"
MAINA_GRADLE_PROJECT_CACHE="${MAINA_GRADLE_PROJECT_CACHE:-$MAINA_BUILD_ROOT/gradle-project-cache}"
MAINA_GRADLE_TOOLS_ROOT="${MAINA_GRADLE_TOOLS_ROOT:-$MAINA_STORAGE_ROOT/caches/toolchains/maina-build-tools/gradle}"
MAINA_JAVA_HOME="${MAINA_JAVA_HOME:-$MAINA_STORAGE_ROOT/caches/toolchains/maina-build-tools/jdk17/Contents/Home}"
MAINA_GRADLE_HOME="${MAINA_GRADLE_HOME:-$MAINA_GRADLE_TOOLS_ROOT/gradle-9.3.1}"
MAINA_ANDROID_OUTPUT_ROOT="${MAINA_ANDROID_OUTPUT_ROOT:-$MAINA_STORAGE_ROOT/builds/apps/$MAINA_STORAGE_SLOT/android/outputs}"
MAINA_ANDROID_NATIVE_ROOT="${MAINA_ANDROID_NATIVE_ROOT:-$MAINA_STORAGE_ROOT/builds/apps/$MAINA_STORAGE_SLOT/android/native}"
MAINA_ANDROID_TEMP_ROOT="${MAINA_ANDROID_TEMP_ROOT:-$MAINA_STORAGE_ROOT/scratch/apps/$MAINA_STORAGE_SLOT/android}"
MAINA_RELEASE_OUTPUT_ROOT="${MAINA_RELEASE_OUTPUT_ROOT:-$MAINA_STORAGE_ROOT/artifacts/apps/$MAINA_STORAGE_SLOT}"
MAINA_NODE_DEPENDENCY_ROOT="${MAINA_NODE_DEPENDENCY_ROOT:-$MAINA_STORAGE_ROOT/dependencies/apps/$MAINA_STORAGE_SLOT}"

[[ "$MAINA_BUILD_ROOT" == '/Users/divay/.cache/maina-build-v2' ]] || {
  maina_storage_fail "The protected internal Maina build parent cannot be redirected."
  return $?
}
[[ -d "$MAINA_BUILD_ROOT" && ! -L "$MAINA_BUILD_ROOT" &&
   -d "$MAINA_BUILD_ROOT/outputs" && ! -L "$MAINA_BUILD_ROOT/outputs" ]] || {
  maina_storage_fail "The protected internal Maina build parent and outputs must remain real directories."
  return $?
}
maina_internal_device="$(/usr/bin/stat -f '%d' "$MAINA_BUILD_ROOT")" || return $?
maina_outputs_device="$(/usr/bin/stat -f '%d' "$MAINA_BUILD_ROOT/outputs")" || return $?
maina_system_device="$(/usr/bin/stat -f '%d' /)" || return $?
[[ "$maina_internal_device" == "$maina_system_device" &&
   "$maina_outputs_device" == "$maina_system_device" ]] || {
  maina_storage_fail "The protected Maina parent or outputs moved off internal storage."
  return $?
}
unset maina_internal_device maina_outputs_device maina_system_device

[[ "$MAINA_GRADLE_USER_HOME" == "$MAINA_BUILD_ROOT/gradle-user-home" &&
   "$MAINA_GRADLE_PROJECT_CACHE" == "$MAINA_BUILD_ROOT/gradle-project-cache" ]] || {
  maina_storage_fail "Only the two approved children of the internal Maina build parent may redirect to Gradle cache storage."
  return $?
}
for maina_external_link in "$MAINA_GRADLE_USER_HOME" "$MAINA_GRADLE_PROJECT_CACHE"; do
  case "$maina_external_link" in
    "$MAINA_BUILD_ROOT/gradle-user-home")
      maina_expected_target="$MAINA_STORAGE_ROOT/caches/android/gradle-user-home"
      ;;
    "$MAINA_BUILD_ROOT/gradle-project-cache")
      maina_expected_target="$MAINA_STORAGE_ROOT/caches/android/gradle-project-cache"
      ;;
  esac
  [[ -L "$maina_external_link" && "$(/usr/bin/readlink "$maina_external_link")" == "$maina_expected_target" ]] || {
    maina_storage_fail "Required Gradle cache link has an unexpected target: $maina_external_link"
    return $?
  }
  maina_external_target="$(/bin/realpath "$maina_external_link")" || {
    maina_storage_fail "Required Gradle cache link target cannot be resolved: $maina_external_link"
    return $?
  }
  [[ "$maina_external_target" == "$maina_expected_target" ]] || {
    maina_storage_fail "Required Gradle cache link resolves to an unexpected target: $maina_external_link"
    return $?
  }
  maina_require_storage_path "$maina_external_target" || return $?
done
unset maina_external_link maina_external_target maina_expected_target

maina_expected_native_root="$MAINA_STORAGE_ROOT/builds/apps/$MAINA_STORAGE_SLOT/android/native"
maina_expected_dependency_root="$MAINA_STORAGE_ROOT/dependencies/apps/$MAINA_STORAGE_SLOT"
[[ "$MAINA_ANDROID_NATIVE_ROOT" == "$maina_expected_native_root" &&
   "$MAINA_NODE_DEPENDENCY_ROOT" == "$maina_expected_dependency_root" ]] || {
  maina_storage_fail "Generated native and dependency roots must retain their canonical external slots."
  return $?
}
unset maina_expected_native_root maina_expected_dependency_root

for maina_external_path in \
  "$MAINA_JAVA_HOME" \
  "$MAINA_ANDROID_OUTPUT_ROOT" \
  "$MAINA_ANDROID_NATIVE_ROOT" \
  "$MAINA_GRADLE_TOOLS_ROOT" \
  "$MAINA_GRADLE_HOME" \
  "$MAINA_ANDROID_TEMP_ROOT" \
  "$MAINA_RELEASE_OUTPUT_ROOT" \
  "$MAINA_NODE_DEPENDENCY_ROOT"; do
  maina_require_storage_path "$maina_external_path" || return $?
done
unset maina_external_path

# Reuse the runtime/device toolchain defaults only after the storage guard and
# protected split have passed, so its historical mkdirs cannot precede the gate.
# shellcheck source=maina-env.sh
source "$MAINA_BUILD_ENV_REPO_ROOT/scripts/maina-env.sh" || return $?
[[ "$MAINA_REPO_ROOT" == "$MAINA_BUILD_ENV_REPO_ROOT" ]] || {
  maina_storage_fail "Maina runtime environment resolved a different repository."
  return $?
}

export GRADLE_USER_HOME="$MAINA_GRADLE_USER_HOME"
export TMPDIR="$MAINA_ANDROID_TEMP_ROOT"
export MAINA_STORAGE_SLOT MAINA_ANDROID_OUTPUT_ROOT MAINA_ANDROID_NATIVE_ROOT
export MAINA_GRADLE_USER_HOME MAINA_GRADLE_PROJECT_CACHE MAINA_GRADLE_TOOLS_ROOT MAINA_GRADLE_HOME
export MAINA_ANDROID_TEMP_ROOT MAINA_RELEASE_OUTPUT_ROOT MAINA_NODE_DEPENDENCY_ROOT

maina_storage_mkdir "$MAINA_ANDROID_OUTPUT_ROOT"
maina_storage_mkdir "$MAINA_ANDROID_NATIVE_ROOT"
maina_storage_mkdir "$MAINA_ANDROID_TEMP_ROOT"
