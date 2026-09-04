#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

[[ -d "$PROJECT_DIR/ios/Maina.xcworkspace" ]] || {
  echo "Generated iOS workspace is missing; run the guarded ios:prepare command first." >&2
  exit 78
}
for argument in "$@"; do
  case "$argument" in
    --output|-o|--output=*|-o=*)
      echo "Custom Expo iOS output paths are disabled; the guarded external output is mandatory." >&2
      exit 78
      ;;
  esac
done
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" ios

expo_output="$MAINA_IOS_BUILD_ROOT/expo-run-output"
maina_storage_mkdir "$expo_output"
export PATH="$PROJECT_DIR/scripts/external-bin:$PATH"

cd "$PROJECT_DIR"
exec npx expo run:ios --output "$expo_output" "$@"
