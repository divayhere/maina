#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-storage.sh
source "$PROJECT_DIR/scripts/maina-storage.sh"

case "$PROJECT_DIR" in
  /Users/divay/Developer/MainaV2) storage_slot='android-main' ;;
  /Users/divay/Developer/.worktrees/maina-ios-feasibility) storage_slot='ios-feasibility' ;;
  *) maina_storage_fail "Refusing links for a non-canonical Maina worktree."; exit $? ;;
esac

ensure_external_link() {
  local link_path="$1"
  local target_path="$2"
  local create_target="$3"

  maina_require_storage_path "$target_path" || exit $?
  if [[ ! -d "$target_path" ]]; then
    if [[ "$create_target" == 'yes' ]]; then
      maina_storage_mkdir "$target_path"
    else
      maina_storage_fail "Required external dependency target is missing: $target_path"
      exit $?
    fi
  fi

  if [[ -L "$link_path" ]]; then
    if [[ "$(/usr/bin/readlink "$link_path")" != "$target_path" ]]; then
      maina_storage_fail "Existing Maina build link has an unexpected target: $link_path"
      exit $?
    fi
    return 0
  fi
  if [[ -e "$link_path" ]]; then
    maina_storage_fail "Refusing to replace an existing non-link path: $link_path"
    exit $?
  fi
  /bin/ln -s "$target_path" "$link_path"
}

ensure_external_file_link() {
  local link_path="$1"
  local source_path="$2"
  local link_parent="${link_path%/*}"

  case "$link_path" in
    "$MAINA_STORAGE_ROOT"/*) ;;
    *) maina_storage_fail "Gradle init link must stay under the guarded external root: $link_path"; exit $? ;;
  esac
  maina_require_storage_path "$link_parent" || exit $?
  [[ -f "$source_path" && ! -L "$source_path" ]] || {
    maina_storage_fail "Required tracked Gradle init script is missing or unsafe: $source_path"
    exit $?
  }
  if [[ -L "$link_path" ]]; then
    [[ "$(/usr/bin/readlink "$link_path")" == "$source_path" ]] || {
      maina_storage_fail "Existing Gradle init link has an unexpected target: $link_path"
      exit $?
    }
    return 0
  fi
  if [[ -e "$link_path" ]]; then
    maina_storage_fail "Refusing to replace an existing Gradle init path: $link_path"
    exit $?
  fi
  /bin/ln -s "$source_path" "$link_path"
}

node_target="$MAINA_STORAGE_ROOT/dependencies/apps/$storage_slot/node_modules"
ensure_external_link "$PROJECT_DIR/node_modules" "$node_target" no

case "${1:-}" in
  dependencies)
    ;;
  android)
    [[ -d "$PROJECT_DIR/android/app" ]] || {
      maina_storage_fail "Generated Android project is missing; refusing link creation."
      exit $?
    }
    ensure_external_link \
      "$PROJECT_DIR/android/build" \
      "$MAINA_STORAGE_ROOT/builds/apps/$storage_slot/android/native/root" yes
    ensure_external_link \
      "$PROJECT_DIR/android/app/build" \
      "$MAINA_STORAGE_ROOT/builds/apps/$storage_slot/android/native/app" yes
    ensure_external_link \
      "$PROJECT_DIR/android/.gradle" \
      "$MAINA_STORAGE_ROOT/caches/android/gradle-project-cache" yes
    init_dir="$MAINA_STORAGE_ROOT/caches/android/gradle-user-home/init.d"
    maina_storage_mkdir "$init_dir"
    ensure_external_file_link \
      "$init_dir/maina-output-redirect.init.gradle" \
      "/Users/divay/Developer/MainaV2/scripts/gradle-output-redirect.init.gradle"
    ;;
  ios)
    [[ -d "$PROJECT_DIR/ios" ]] || {
      maina_storage_fail "Generated iOS project is missing; refusing link creation."
      exit $?
    }
    ensure_external_link \
      "$PROJECT_DIR/ios/Pods" \
      "$MAINA_STORAGE_ROOT/dependencies/apps/$storage_slot/Pods" yes
    ensure_external_link \
      "$PROJECT_DIR/ios/build" \
      "$MAINA_STORAGE_ROOT/builds/apps/$storage_slot/ios/native" yes
    ;;
  *)
    echo "Usage: $0 dependencies|android|ios" >&2
    exit 64
    ;;
esac

printf 'Maina %s external links are exact.\n' "${1:-dependencies}"
