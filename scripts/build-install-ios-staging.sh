#!/usr/bin/env bash
set -euo pipefail

# Deterministic local staging release for the one qualified USB iPhone 15.
# Override the identifiers explicitly when the physical staging phone changes.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
DEVICE_ID="${MAINA_IOS_DEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
DEVICE_UDID="${MAINA_IOS_DEVICE_UDID:-00008120-001E146611E2601E}"
BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"
MIN_FREE_KB=$((8 * 1024 * 1024))

export PATH="$NODE_BIN:$PATH"
export NODE_BINARY="$NODE_BIN/node"
if [[ -z "${SENTRY_AUTH_TOKEN:-}" ]]; then
  export SENTRY_DISABLE_AUTO_UPLOAD=true
  export SENTRY_ALLOW_FAILURE=true
fi

cd "$PROJECT_DIR"
[[ "$(node --version)" == v24.* ]] || { echo "Maina iOS requires Node 24." >&2; exit 1; }
xcodebuild -checkFirstLaunchStatus
[[ -d ios/Maina.xcworkspace ]] || { echo "Run npm run ios:prepare first; ios/Maina.xcworkspace is missing." >&2; exit 1; }

device_line="$(xcrun devicectl list devices | grep "$DEVICE_ID" || true)"
[[ "$device_line" == *"connected"* && "$device_line" == *"iPhone 15"* ]] || {
  echo "Qualified USB iPhone 15 is not connected: $DEVICE_ID ($DEVICE_UDID)." >&2
  exit 1
}

free_kb="$(df -Pk / | awk 'NR == 2 {print $4}')"
(( free_kb >= MIN_FREE_KB )) || {
  echo "At least 8 GB free is required for a clean iOS release build." >&2
  exit 1
}

version="$(node -p "require('./app.json').expo.version")"
build_number="$(node -p "require('./app.json').expo.ios.buildNumber")"
configured_bundle="$(node -p "require('./app.json').expo.ios.bundleIdentifier")"
[[ "$configured_bundle" == "$BUNDLE_ID" ]] || {
  echo "Bundle mismatch: app.json=$configured_bundle expected=$BUNDLE_ID" >&2
  exit 1
}

npm run typecheck
npm run lint
npm test -- --run
npm run verify:ios-native

build_root="${MAINA_IOS_BUILD_ROOT:-/Users/divay/Developer/.builds/maina-ios-release-v${build_number}}"
xcodebuild \
  -workspace ios/Maina.xcworkspace \
  -scheme Maina \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$build_root" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$build_number" \
  MARKETING_VERSION="$version" \
  build

app="$build_root/Build/Products/Release-iphoneos/Maina.app"
codesign --verify --deep --strict "$app"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")" == "$version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")" == "$build_number" ]]

xcrun devicectl device process terminate --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun devicectl device install app --device "$DEVICE_ID" "$app"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID"

echo "Installed Maina $version ($build_number) on the qualified USB iPhone 15."
