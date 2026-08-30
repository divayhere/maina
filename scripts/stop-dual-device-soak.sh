#!/usr/bin/env bash
set -euo pipefail

# Physical-device qualification helper. The caller supplies the absolute stop
# epoch so this script can keep an already-running soak independent of Codex's
# foreground turn. It targets only the explicitly named Pixel and iPhone 15.

TARGET_EPOCH="${1:?target epoch is required}"
ANDROID_SERIAL="${MAINA_ANDROID_SERIAL:?exact Android serial is required}"
IOS_COREDEVICE_ID="${MAINA_IOS_COREDEVICE_ID:?exact CoreDevice identifier is required}"
IOS_UDID="${MAINA_IOS_UDID:?exact iPhone 15 UDID is required}"
IOS_BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
IOS_XCTESTRUN="${MAINA_IOS_XCTESTRUN:?prebuilt Maina UI-test xctestrun file is required}"
LOG_DIR="${MAINA_SOAK_LOG_DIR:-/tmp/maina-dual-soak}"

mkdir -p "$LOG_DIR"

while (( $(date +%s) < TARGET_EPOCH )); do
  now="$(date +%s)"
  remaining=$((TARGET_EPOCH - now))
  printf '%s waiting_to_stop remaining_seconds=%s\n' "$(date -Iseconds)" "$remaining" >> "$LOG_DIR/autonomous-stop.log"
  sleep 20
done

printf '%s autonomous_stop_started\n' "$(date -Iseconds)" >> "$LOG_DIR/autonomous-stop.log"

# Android's exported local command receiver follows the same graceful
# stop-and-save path as its notification and clicker.
adb -s "$ANDROID_SERIAL" shell am broadcast \
  -a com.divay.maina.action.STOP \
  -p com.divay.maina \
  >> "$LOG_DIR/android-stop.log" 2>&1

# Use the qualification-only UI control that activates the existing process.
# It never calls XCUIApplication.launch(), installs, clears data, attaches a
# debugger, or sends a process-termination command. Fail closed when the signed
# runner is unavailable instead of improvising against a live recording.
test -f "$IOS_XCTESTRUN"
MAINA_UI_ATTACH_RUNNING=1 xcodebuild test-without-building \
  -xctestrun "$IOS_XCTESTRUN" \
  -destination "platform=iOS,id=$IOS_UDID" \
  -only-testing:MainaUITests/MainaUITests/testStopExistingRecording \
  > "$LOG_DIR/ios-stop-ui-test.log" 2>&1

sleep 20

adb -s "$ANDROID_SERIAL" shell dumpsys audio > "$LOG_DIR/android-audio-after-stop.txt" 2>&1 || true
xcrun devicectl device info processes \
  --device "$IOS_COREDEVICE_ID" \
  --timeout 15 \
  2>&1 | grep 'Maina.app/Maina' > "$LOG_DIR/ios-process-after-stop.txt" || true

printf '%s autonomous_stop_completed\n' "$(date -Iseconds)" >> "$LOG_DIR/autonomous-stop.log"
