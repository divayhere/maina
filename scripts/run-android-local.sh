#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"

[[ -d "$PROJECT_DIR/android/app" ]] || {
  echo "Generated Android project is missing; run the guarded android:prepare command first." >&2
  exit 78
}
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" android

[[ -z "${GRADLE_OPTS:-}" ]] || {
  echo "Refusing caller-supplied GRADLE_OPTS that could bypass guarded output routing." >&2
  exit 78
}
for argument in "$@"; do
  [[ "$argument" != '--no-build-cache' ]] || {
    echo "Expo clean builds are restricted to the guarded android:prepare and candidate workflows." >&2
    exit 78
  }
done

cd "$PROJECT_DIR"
exec npx expo run:android "$@"
