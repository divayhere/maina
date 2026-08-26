#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned Sherpa-ONNX iOS XCFramework outside Git. The ASR model is
# intentionally a later runtime download into the app sandbox; it is never
# bundled in an IPA.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="1.13.4"
EXPECTED_SHA256="74306ad04310d921ce0ba9b356a349a2020a0eb79994da33e356e67f303e42c6"
ARCHIVE_NAME="sherpa-onnx-v${VERSION}-ios-no-tts.xcframework.zip"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${ARCHIVE_NAME}"
CACHE_ROOT="${MAINA_IOS_RUNTIME_CACHE:-$PROJECT_DIR/.artifacts/ios-runtime}"
ARCHIVE="$CACHE_ROOT/$ARCHIVE_NAME"
SOURCE_ARCHIVE="${MAINA_SHERPA_ARCHIVE:-}"
VENDOR_ROOT="$PROJECT_DIR/modules/maina-recorder/ios/vendor"
FRAMEWORK="$VENDOR_ROOT/sherpa-onnx.xcframework"

mkdir -p "$CACHE_ROOT" "$VENDOR_ROOT"

if [[ -n "$SOURCE_ARCHIVE" ]]; then
  if [[ ! -f "$SOURCE_ARCHIVE" ]]; then
    echo "MAINA_SHERPA_ARCHIVE does not exist: $SOURCE_ARCHIVE" >&2
    exit 1
  fi
  cp "$SOURCE_ARCHIVE" "$ARCHIVE.partial"
  mv "$ARCHIVE.partial" "$ARCHIVE"
elif [[ ! -f "$ARCHIVE" ]]; then
  echo "Downloading pinned Sherpa iOS runtime v${VERSION}…"
  curl --fail --location --retry 20 --retry-delay 2 --retry-all-errors \
    --continue-at - --connect-timeout 20 \
    --output "$ARCHIVE.partial" "$URL"
  mv "$ARCHIVE.partial" "$ARCHIVE"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  rm -f "$ARCHIVE"
  echo "Sherpa iOS runtime checksum mismatch; removed untrusted download." >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/maina-sherpa.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
unzip -q "$ARCHIVE" -d "$TMP_ROOT"
CANDIDATE="$(find "$TMP_ROOT" -type d -name 'sherpa-onnx.xcframework' -print -quit)"
if [[ -z "$CANDIDATE" ]]; then
  echo "Sherpa archive did not contain sherpa-onnx.xcframework." >&2
  exit 1
fi

rm -rf "$FRAMEWORK.partial"
cp -R "$CANDIDATE" "$FRAMEWORK.partial"

# CocoaPods links static XCFramework libraries with `-l<name>`, which requires
# the conventional `lib` prefix. Sherpa's official archive is valid for Swift
# Package Manager but ships `sherpa-onnx.a`; normalize the copied (not cached)
# artifact so CocoaPods can resolve `-lsherpa-onnx` deterministically.
while IFS= read -r library; do
  mv "$library" "$(dirname "$library")/libsherpa-onnx.a"
done < <(find "$FRAMEWORK.partial" -type f -name 'sherpa-onnx.a' -print)
for index in 0 1; do
  /usr/libexec/PlistBuddy -c "Set :AvailableLibraries:${index}:BinaryPath libsherpa-onnx.a" "$FRAMEWORK.partial/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :AvailableLibraries:${index}:LibraryPath libsherpa-onnx.a" "$FRAMEWORK.partial/Info.plist"
done

rm -rf "$FRAMEWORK"
mv "$FRAMEWORK.partial" "$FRAMEWORK"
echo "Sherpa iOS runtime ready: $FRAMEWORK"
