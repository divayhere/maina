#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-env.sh
source "$PROJECT_DIR/scripts/maina-env.sh"

cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/verify-toolchain.sh"
npm run verify:coordination
npm run verify:native-recorder
npm run typecheck
npm test
npm run lint
npx expo install --check
"$PROJECT_DIR/scripts/prebuild-android.sh"

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
./gradlew \
  --gradle-user-home "$GRADLE_USER_HOME" \
  --project-cache-dir "$MAINA_BUILD_ROOT/gradle-project-cache" \
  --init-script "$PROJECT_DIR/scripts/gradle-output-redirect.init.gradle" \
  -PreactNativeArchitectures="$MAINA_ANDROID_ABI" \
  :maina-recorder:testDebugUnitTest :maina-recorder:compileDebugKotlin :app:compileDebugKotlin :app:mergeDebugNativeLibs \
  --console=plain --no-daemon

MERGED_NATIVE_ROOT="$MAINA_BUILD_ROOT/outputs"
if ! find "$MERGED_NATIVE_ROOT" -type f \( -name 'libonnxruntime.so' -o -name 'libsherpa-onnx-jni.so' \) | grep -q .; then
  echo "Sherpa JNI runtime was not merged into the Android app output" >&2
  exit 1
fi

# Expo autolinking asks native CMake modules for package-local generated code.
# Keep this explicit: a broad external build-dir redirect can pass Kotlin but
# move these files away from CMake and make the next clean native build fail.
for GENERATED_CODEGEN in \
  "$PROJECT_DIR/node_modules/react-native-reanimated/android/build/generated/source/codegen/jni/CMakeLists.txt" \
  "$PROJECT_DIR/node_modules/react-native-worklets/android/build/generated/source/codegen/jni/CMakeLists.txt" \
  "$PROJECT_DIR/node_modules/react-native-gesture-handler/android/build/generated/source/codegen/jni/CMakeLists.txt" \
  "$PROJECT_DIR/node_modules/@sentry/react-native/android/build/generated/source/codegen/jni/CMakeLists.txt"; do
  if [[ ! -f "$GENERATED_CODEGEN" ]]; then
    echo "Required native codegen output was not generated: $GENERATED_CODEGEN" >&2
    exit 1
  fi
done

DEBUG_MANIFEST="$(find "$MAINA_BUILD_ROOT/outputs" \
  -path '*/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml' \
  -o -path '*/merged_manifests/debug/processDebugManifest/AndroidManifest.xml' \
  | head -n 1)"
if [[ -z "$DEBUG_MANIFEST" || ! -f "$DEBUG_MANIFEST" ]]; then
  echo "Debug merged manifest not found after local verification build" >&2
  exit 1
fi

rg -q 'MainaRecordingService' "$DEBUG_MANIFEST"
rg -q 'MainaPostProcessingService' "$DEBUG_MANIFEST"
rg -q 'MainaCommandReceiver' "$DEBUG_MANIFEST"
rg -q 'MainaKeyAccessibilityService' "$DEBUG_MANIFEST"
rg -q 'android:process=":remote_control"' "$DEBUG_MANIFEST"
rg -q 'android.permission.BIND_ACCESSIBILITY_SERVICE' "$DEBUG_MANIFEST"
rg -q 'FOREGROUND_SERVICE_MICROPHONE' "$DEBUG_MANIFEST"
rg -q 'FOREGROUND_SERVICE_MEDIA_PROCESSING' "$DEBUG_MANIFEST"
rg -q 'android:foregroundServiceType="mediaProcessing"' "$DEBUG_MANIFEST"

RELEASE_MANIFEST="$(find "$MAINA_BUILD_ROOT/outputs" \
  -path '*/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml' \
  -o -path '*/merged_manifests/release/processReleaseManifest/AndroidManifest.xml' \
  | head -n 1)"
if [[ -n "$RELEASE_MANIFEST" && -f "$RELEASE_MANIFEST" ]] && rg -q '<profileable' "$RELEASE_MANIFEST"; then
  echo "Release manifest must not remain shell-profileable" >&2
  exit 1
fi

echo "Maina release verification passed. Export: $EXPORT_DIR"
