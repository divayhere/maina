#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-storage.sh
source "$PROJECT_DIR/scripts/maina-storage.sh"

if [[ "$PROJECT_DIR" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]; then
  maina_storage_fail "iOS UI-test configuration is restricted to the canonical iOS worktree."
  exit $?
fi

# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"
cd "$PROJECT_DIR"
exec "$MAINA_IOS_RUBY_BIN/ruby" scripts/configure-ios-ui-tests.rb
