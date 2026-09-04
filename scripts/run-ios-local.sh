#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-storage.sh
source "$PROJECT_DIR/scripts/maina-storage.sh"

echo "iOS builds are restricted to /Users/divay/Developer/.worktrees/maina-ios-feasibility." >&2
exit 78
