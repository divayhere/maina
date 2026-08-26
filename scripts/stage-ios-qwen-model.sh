#!/usr/bin/env bash
set -euo pipefail

# Stages the already-qualified Qwen pack into an installed development build.
# This is intentionally a USB development tool, not the eventual public model
# installer. devicectl copies only changed files and never exposes app secrets.
DEVICE="${MAINA_IOS_DEVICE:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
MODEL_ROOT="${MAINA_QWEN_MODEL_ROOT:-/Users/divay/.cache/maina-models/qwen3-2026-03-25}"
DESTINATION="Library/Application Support/Maina/models/qwen3-asr-0.6b-int8"

declare -a EXPECTED=(
  "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e  conv_frontend.onnx"
  "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9  encoder.int8.onnx"
  "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771  decoder.int8.onnx"
  "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910  tokenizer/vocab.json"
  "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5  tokenizer/merges.txt"
  "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c  tokenizer/tokenizer_config.json"
)

for entry in "${EXPECTED[@]}"; do
  checksum="${entry%%  *}"
  relative="${entry#*  }"
  file="$MODEL_ROOT/$relative"
  [[ -f "$file" ]] || { echo "Missing Qwen model file: $file" >&2; exit 1; }
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [[ "$actual" == "$checksum" ]] || {
    echo "Qwen model checksum mismatch: $relative" >&2
    exit 1
  }
done

xcrun devicectl device info apps \
  --device "$DEVICE" \
  --bundle-id "$BUNDLE_ID" \
  --hide-headers >/dev/null

xcrun devicectl device copy to \
  --device "$DEVICE" \
  --source "$MODEL_ROOT" \
  --destination "$DESTINATION" \
  --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" \
  --timeout 900

echo "Verified Qwen model staged for $BUNDLE_ID on $DEVICE."
