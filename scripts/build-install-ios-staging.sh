#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"

RELEASE_PLAN="$PROJECT_DIR/release/m3-m4-0.10.49-candidate-plan.json"
ACTIVE_CANDIDATE_VERSION="$("$MAINA_IOS_NODE_BIN/node" -p "require('$RELEASE_PLAN').release.version")"
if [[ "$("$MAINA_IOS_NODE_BIN/node" -p "require('$PROJECT_DIR/app.json').expo.version")" == "$ACTIVE_CANDIDATE_VERSION" ]]; then
  echo "Refusing combined candidate build/install. Use ios:build-candidate, Admin artifact audit, then ios:install-preserving." >&2
  exit 2
fi

# Deterministic local staging release for the one qualified USB iPhone 15.
# Override the identifiers explicitly when the physical staging phone changes.
NODE_BIN="$MAINA_IOS_NODE_BIN"
DEVICE_ID="${MAINA_IOS_DEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
DEVICE_UDID="${MAINA_IOS_DEVICE_UDID:-00008120-001E146611E2601E}"
DEVICE_PRODUCT_TYPE="${MAINA_IOS_DEVICE_PRODUCT_TYPE:-iPhone15,4}"
PYMOBILEDEVICE3_BIN="${MAINA_PYMOBILEDEVICE3_BIN:-$PROJECT_DIR/.tools/pymobiledevice3-venv/bin/pymobiledevice3}"
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
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies
"$PROJECT_DIR/scripts/restore-external-build-links.sh" ios
xcodebuild -checkFirstLaunchStatus
[[ -d ios/Maina.xcworkspace ]] || { echo "Run npm run ios:prepare first; ios/Maina.xcworkspace is missing." >&2; exit 1; }

[[ -x "$PYMOBILEDEVICE3_BIN" ]] || {
  echo "USB device verifier is unavailable: $PYMOBILEDEVICE3_BIN" >&2
  exit 1
}
usb_device_json="$("$PYMOBILEDEVICE3_BIN" usbmux list)"
usb_device_ok="$(USBMUX_JSON="$usb_device_json" node -e '
  const devices = JSON.parse(process.env.USBMUX_JSON || "[]");
  const expectedUdid = process.argv[1];
  const expectedProduct = process.argv[2];
  const device = devices.find((candidate) => candidate.Identifier === expectedUdid);
  process.stdout.write(
    device?.ConnectionType === "USB" && device?.ProductType === expectedProduct ? "yes" : "no",
  );
' "$DEVICE_UDID" "$DEVICE_PRODUCT_TYPE")"
[[ "$usb_device_ok" == "yes" ]] || {
  echo "Qualified USB iPhone 15 is not physically connected: $DEVICE_ID ($DEVICE_UDID, $DEVICE_PRODUCT_TYPE)." >&2
  exit 1
}

free_kb="$(df -Pk "$MAINA_STORAGE_ROOT" | awk 'NR == 2 {print $4}')"
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

build_root="${MAINA_IOS_STAGING_DERIVED_DATA:-$MAINA_IOS_DERIVED_DATA_ROOT/staging-v${build_number}}"
maina_require_storage_path "$build_root" || exit $?
case "$build_root" in
  "$MAINA_IOS_DERIVED_DATA_ROOT"/staging-v*) ;;
  *) echo "Refusing to clean unexpected iOS build root: $build_root" >&2; exit 1 ;;
esac
# Release evidence must never reuse stale Clang/Swift modules after pod or
# Xcode changes. This directory contains generated build output only.
rm -rf "$build_root"
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
  PODFILE_DIR="$PROJECT_DIR/ios" \
  build

app="$build_root/Build/Products/Release-iphoneos/Maina.app"
codesign --verify --deep --strict "$app"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")" == "$version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")" == "$build_number" ]]

xcrun devicectl device process terminate --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun devicectl device install app --device "$DEVICE_ID" "$app"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID"

echo "Installed Maina $version ($build_number) on the qualified USB iPhone 15."
