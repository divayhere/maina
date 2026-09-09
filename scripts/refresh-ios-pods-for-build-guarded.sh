#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$PROJECT_DIR" != '/Users/divay/Developer/.worktrees/maina-ios-feasibility' ]]; then
  echo "iOS pod refresh is restricted to the canonical iOS worktree." >&2
  exit 78
fi

# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"
cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" ios

[[ "$(pod --version)" == "1.17.0" ]] || {
  echo "Pinned CocoaPods 1.17.0 is unavailable." >&2
  exit 78
}
for required in ios/Podfile ios/Podfile.lock ios/Pods/Manifest.lock; do
  [[ -f "$required" && ! -L "$required" ]] || {
    echo "Required iOS dependency state is missing or unsafe." >&2
    exit 78
  }
done
before_lock_sha="$(/usr/bin/shasum -a 256 ios/Podfile.lock | /usr/bin/awk '{print $1}')"

(cd ios && PROJECT_ROOT="$PROJECT_DIR" pod install --deployment)

after_lock_sha="$(/usr/bin/shasum -a 256 ios/Podfile.lock | /usr/bin/awk '{print $1}')"
[[ "$after_lock_sha" == "$before_lock_sha" ]] || {
  echo "IOS_POD_LOCK_DRIFT" >&2
  exit 78
}
/usr/bin/cmp -s ios/Podfile.lock ios/Pods/Manifest.lock || {
  echo "IOS_POD_LOCK_DRIFT" >&2
  exit 78
}
exec "$MAINA_IOS_RUBY_BIN/ruby" scripts/verify-ios-pod-source-membership.rb
