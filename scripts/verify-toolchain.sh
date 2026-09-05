#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${MAINA_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
[[ -x "$NODE_BIN/node" ]] || { echo "ANDROID_QUALIFICATION_NODE_UNAVAILABLE" >&2; exit 2; }

# The adapter performs read-only capability checks without sourcing environment
# helpers that create build/cache directories.
exec "$NODE_BIN/node" "$PROJECT_DIR/scripts/qualification/android-lane.mjs" preflight
