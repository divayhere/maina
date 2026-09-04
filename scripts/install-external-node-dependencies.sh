#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

dependency_root="$MAINA_IOS_NODE_DEPENDENCY_ROOT"
maina_storage_mkdir "$dependency_root"
maina_storage_mkdir "$dependency_root/node_modules"

ensure_metadata_link() {
  local link_path="$1"
  local source_path="$2"
  [[ -e "$source_path" ]] || {
    echo "Required dependency metadata is missing: $source_path" >&2
    exit 78
  }
  if [[ -L "$link_path" ]]; then
    [[ "$(/usr/bin/readlink "$link_path")" == "$source_path" ]] || {
      echo "External dependency metadata link is unexpected: $link_path" >&2
      exit 78
    }
  elif [[ -e "$link_path" ]]; then
    echo "Refusing to replace external dependency metadata: $link_path" >&2
    exit 78
  else
    /bin/ln -s "$source_path" "$link_path"
  fi
}

ensure_metadata_link "$dependency_root/package.json" "$PROJECT_DIR/package.json"
ensure_metadata_link "$dependency_root/package-lock.json" "$PROJECT_DIR/package-lock.json"
ensure_metadata_link "$dependency_root/patches" "$PROJECT_DIR/patches"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies

(
  cd "$dependency_root"
  NODE_ENV=development npm ci
)

"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
