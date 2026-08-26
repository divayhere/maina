#!/usr/bin/env bash
set -euo pipefail

# Installs the pinned Sherpa-ONNX iOS XCFramework outside Git. The ASR model is
# intentionally a later runtime download into the app sandbox; it is never
# bundled in an IPA.
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="1.13.4"
EXPECTED_SHA256="c5a62904bba73edc4bac89bbf51b4c3db1dd6c1b397a16ee95b2ff94701e9846"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/sherpa-onnx-v${VERSION}-ios.xcframework.zip"
CACHE_ROOT="${MAINA_IOS_RUNTIME_CACHE:-$PROJECT_DIR/.artifacts/ios-runtime}"
ARCHIVE="$CACHE_ROOT/sherpa-onnx-v${VERSION}-ios.xcframework.zip"
VENDOR_ROOT="$PROJECT_DIR/modules/maina-recorder/ios/vendor"
FRAMEWORK="$VENDOR_ROOT/sherpa-onnx.xcframework"

mkdir -p "$CACHE_ROOT" "$VENDOR_ROOT"

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Downloading pinned Sherpa iOS runtime v${VERSION}…"
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 \
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
rm -rf "$FRAMEWORK"
mv "$FRAMEWORK.partial" "$FRAMEWORK"
echo "Sherpa iOS runtime ready: $FRAMEWORK"
