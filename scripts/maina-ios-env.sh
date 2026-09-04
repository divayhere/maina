#!/usr/bin/env bash
# Source this file before every local iOS dependency, prebuild, or build action.

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "Maina iOS build scripts require Bash." >&2
  return 78 2>/dev/null || exit 78
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file from a Maina iOS build script." >&2
  exit 78
fi

MAINA_IOS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$MAINA_IOS_REPO_ROOT" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]; then
  echo "Maina iOS repository is not the approved canonical worktree." >&2
  return 78
fi

# shellcheck source=maina-storage.sh
source "$MAINA_IOS_REPO_ROOT/scripts/maina-storage.sh" || return $?

MAINA_IOS_STORAGE_SLOT='ios-feasibility'
MAINA_IOS_NODE_BIN="${MAINA_IOS_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
MAINA_IOS_RUBY_BIN="${MAINA_IOS_RUBY_BIN:-/Users/divay/Developer/.tools/maina-ruby-3.3.9-v2/bin}"
MAINA_IOS_BUILD_ROOT="${MAINA_IOS_BUILD_ROOT:-$MAINA_STORAGE_ROOT/builds/apps/$MAINA_IOS_STORAGE_SLOT/ios}"
MAINA_IOS_DERIVED_DATA_ROOT="${MAINA_IOS_DERIVED_DATA_ROOT:-$MAINA_IOS_BUILD_ROOT/DerivedData}"
MAINA_IOS_RELEASE_OUTPUT_ROOT="${MAINA_IOS_RELEASE_OUTPUT_ROOT:-$MAINA_STORAGE_ROOT/artifacts/apps/$MAINA_IOS_STORAGE_SLOT}"
MAINA_IOS_TEMP_ROOT="${MAINA_IOS_TEMP_ROOT:-$MAINA_STORAGE_ROOT/scratch/apps/$MAINA_IOS_STORAGE_SLOT/ios}"
MAINA_IOS_COCOAPODS_HOME="${MAINA_IOS_COCOAPODS_HOME:-$MAINA_STORAGE_ROOT/caches/ios/cocoapods/home}"
MAINA_IOS_COCOAPODS_CACHE="${MAINA_IOS_COCOAPODS_CACHE:-$MAINA_STORAGE_ROOT/caches/ios/cocoapods/cache}"
MAINA_IOS_RUNTIME_CACHE="${MAINA_IOS_RUNTIME_CACHE:-$MAINA_STORAGE_ROOT/caches/ios/runtime}"
MAINA_IOS_NODE_DEPENDENCY_ROOT="${MAINA_IOS_NODE_DEPENDENCY_ROOT:-$MAINA_STORAGE_ROOT/dependencies/apps/$MAINA_IOS_STORAGE_SLOT}"
MAINA_NPM_CACHE="${MAINA_NPM_CACHE:-$MAINA_STORAGE_ROOT/caches/node/npm}"

for maina_external_path in \
  "$MAINA_IOS_BUILD_ROOT" \
  "$MAINA_IOS_DERIVED_DATA_ROOT" \
  "$MAINA_IOS_RELEASE_OUTPUT_ROOT" \
  "$MAINA_IOS_TEMP_ROOT" \
  "$MAINA_IOS_COCOAPODS_HOME" \
  "$MAINA_IOS_COCOAPODS_CACHE" \
  "$MAINA_IOS_RUNTIME_CACHE" \
  "$MAINA_IOS_NODE_DEPENDENCY_ROOT" \
  "$MAINA_NPM_CACHE"; do
  maina_require_storage_path "$maina_external_path" || return $?
done
unset maina_external_path

export PATH="$MAINA_IOS_NODE_BIN:$MAINA_IOS_RUBY_BIN:$PATH"
export NODE_BINARY="$MAINA_IOS_NODE_BIN/node"
export TMPDIR="$MAINA_IOS_TEMP_ROOT"
export CP_HOME_DIR="$MAINA_IOS_COCOAPODS_HOME"
export CP_CACHE_DIR="$MAINA_IOS_COCOAPODS_CACHE"
export NPM_CONFIG_CACHE="$MAINA_NPM_CACHE"
export npm_config_cache="$MAINA_NPM_CACHE"
export MAINA_IOS_REPO_ROOT MAINA_IOS_STORAGE_SLOT MAINA_IOS_NODE_BIN MAINA_IOS_RUBY_BIN
export MAINA_IOS_BUILD_ROOT MAINA_IOS_DERIVED_DATA_ROOT MAINA_IOS_RELEASE_OUTPUT_ROOT
export MAINA_IOS_TEMP_ROOT MAINA_IOS_COCOAPODS_HOME MAINA_IOS_COCOAPODS_CACHE
export MAINA_IOS_RUNTIME_CACHE MAINA_IOS_NODE_DEPENDENCY_ROOT MAINA_NPM_CACHE

maina_storage_mkdir "$MAINA_IOS_BUILD_ROOT"
maina_storage_mkdir "$MAINA_IOS_DERIVED_DATA_ROOT"
maina_storage_mkdir "$MAINA_IOS_TEMP_ROOT"
maina_storage_mkdir "$MAINA_IOS_COCOAPODS_HOME"
maina_storage_mkdir "$MAINA_IOS_COCOAPODS_CACHE"
maina_storage_mkdir "$MAINA_IOS_RUNTIME_CACHE"
maina_storage_mkdir "$MAINA_IOS_NODE_DEPENDENCY_ROOT"
maina_storage_mkdir "$MAINA_NPM_CACHE"
