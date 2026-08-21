#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${MAINA_JAVA_HOME:-$PROJECT_DIR/.tools/jdk17/jdk-17.0.20+8/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$PROJECT_DIR/.tools/android-sdk}"
export NODE_ENV=production

cd "$PROJECT_DIR"
npm run typecheck
npm test
npm run lint
npx expo install --check
npx expo-doctor@latest

MEETING_DETAIL="$PROJECT_DIR/src/app/(tabs)/meeting/[id].tsx"
if [[ ! -f "$MEETING_DETAIL" ]]; then
  echo "Meeting detail screen not found at expected route" >&2
  exit 1
fi
if rg -q 'ScrollView' "$MEETING_DETAIL"; then
  echo "Meeting detail must not render transcripts through ScrollView" >&2
  exit 1
fi
if rg -q 'queueTextArtifact\(' "$PROJECT_DIR/src/app/record.tsx" "$PROJECT_DIR/src/app/_layout.tsx"; then
  echo "Hot transcript paths must not queue full transcript text artifacts automatically" >&2
  exit 1
fi

EXPORT_DIR="$(mktemp -d -t maina-export.XXXXXX)"
npx expo export --platform android --output-dir "$EXPORT_DIR"

cd "$PROJECT_DIR/android"
./gradlew :maina-recorder:testDebugUnitTest :maina-recorder:compileDebugKotlin :app:compileDebugKotlin --console=plain

DEBUG_MANIFEST="$(find "$PROJECT_DIR/android/app/build/intermediates" \
  -path '*/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml' \
  -o -path '*/merged_manifests/debug/processDebugManifest/AndroidManifest.xml' \
  | head -n 1)"
if [[ -z "$DEBUG_MANIFEST" || ! -f "$DEBUG_MANIFEST" ]]; then
  echo "Debug merged manifest not found after local verification build" >&2
  exit 1
fi

rg -q 'MainaRecordingService' "$DEBUG_MANIFEST"
rg -q 'MainaCommandReceiver' "$DEBUG_MANIFEST"
rg -q 'MainaKeyAccessibilityService' "$DEBUG_MANIFEST"
rg -q 'android:process=":remote_control"' "$DEBUG_MANIFEST"
rg -q 'android.permission.BIND_ACCESSIBILITY_SERVICE' "$DEBUG_MANIFEST"
rg -q 'FOREGROUND_SERVICE_MICROPHONE' "$DEBUG_MANIFEST"

RELEASE_MANIFEST="$(find "$PROJECT_DIR/android/app/build/intermediates" \
  -path '*/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml' \
  -o -path '*/merged_manifests/release/processReleaseManifest/AndroidManifest.xml' \
  | head -n 1)"
if [[ -n "$RELEASE_MANIFEST" && -f "$RELEASE_MANIFEST" ]] && rg -q '<profileable' "$RELEASE_MANIFEST"; then
  echo "Release manifest must not remain shell-profileable" >&2
  exit 1
fi

echo "Maina release verification passed. Export: $EXPORT_DIR"
