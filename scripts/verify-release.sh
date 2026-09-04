#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-build-env.sh
source "$PROJECT_DIR/scripts/maina-build-env.sh"
"$MAINA_NODE_BIN/node" "$PROJECT_DIR/scripts/verify-external-storage-contract.mjs"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies

cd "$PROJECT_DIR"
"$PROJECT_DIR/scripts/ensure-gradle.sh"
"$PROJECT_DIR/scripts/verify-toolchain.sh"
npm run verify:coordination
npm run verify:mkc-release-a
npm run verify:mkc-memory-contracts
npm run verify:native-recorder
npm run typecheck
npm test
npm run lint
npx expo install --check
"$PROJECT_DIR/scripts/prebuild-android.sh"

MEETING_DETAIL="$PROJECT_DIR/src/app/meeting/[id].tsx"
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

EXPORT_DIR="$(mktemp -d "$MAINA_ANDROID_TEMP_ROOT/maina-export.XXXXXX")"
npx expo export --platform android --output-dir "$EXPORT_DIR"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" android

cd "$PROJECT_DIR/android"
"$MAINA_GRADLE_HOME/bin/gradle" \
  --gradle-user-home "$GRADLE_USER_HOME" \
  --project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE" \
  -PreactNativeArchitectures="$MAINA_ANDROID_ABI" \
  :maina-recorder:testDebugUnitTest :maina-recorder:compileDebugKotlin :app:compileDebugKotlin :app:mergeDebugAssets :app:mergeDebugNativeLibs \
  --console=plain --no-daemon

MERGED_NATIVE_ROOT="$MAINA_ANDROID_OUTPUT_ROOT"
if ! find "$MERGED_NATIVE_ROOT" -type f \( -name 'libonnxruntime.so' -o -name 'libsherpa-onnx-jni.so' \) | grep -q .; then
  echo "Sherpa JNI runtime was not merged into the Android app output" >&2
  exit 1
fi

# Maina's native VAD uses a small, checksum-pinned model asset. Verify it at
# the *app* merge layer, not only inside the Expo module, so a future Gradle or
# autolinking change cannot compile Kotlin successfully but ship an APK that
# crashes on its first post-recording transcription.
VAD_ASSET="$(find "$MAINA_ANDROID_OUTPUT_ROOT/_app" \
  -path '*/intermediates/assets/debug/mergeDebugAssets/silero_vad.int8.onnx' \
  -type f | head -n 1)"
if [[ -z "$VAD_ASSET" || ! -f "$VAD_ASSET" ]]; then
  echo "Silero VAD asset was not merged into the Android app assets" >&2
  exit 1
fi
VAD_SHA256="$(shasum -a 256 "$VAD_ASSET" | awk '{print $1}')"
if [[ "$VAD_SHA256" != 'c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20' ]]; then
  echo "Merged Silero VAD asset checksum mismatch: $VAD_SHA256" >&2
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

DEBUG_MANIFEST="$(find "$MAINA_ANDROID_OUTPUT_ROOT" \
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

RELEASE_MANIFEST="$(find "$MAINA_ANDROID_OUTPUT_ROOT" \
  -path '*/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml' \
  -o -path '*/merged_manifests/release/processReleaseManifest/AndroidManifest.xml' \
  | head -n 1)"
if [[ -n "$RELEASE_MANIFEST" && -f "$RELEASE_MANIFEST" ]] && rg -q '<profileable' "$RELEASE_MANIFEST"; then
  echo "Release manifest must not remain shell-profileable" >&2
  exit 1
fi

echo "Maina release verification passed. Export: $EXPORT_DIR"
