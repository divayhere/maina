#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-preflight}"
TEST_NAME="${2:-test3-call-interruption}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_SERIAL="${MAINA_ANDROID_SERIAL:-adb-47011FDAP000VE-9s0wNO._adb-tls-connect._tcp}"
IOS_COREDEVICE_ID="${MAINA_IOS_COREDEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
IOS_UDID="${MAINA_IOS_UDID:-00008120-001E146611E2601E}"
IOS_SERIAL="${MAINA_IOS_SERIAL:-MQLF6GV3XM}"
ANDROID_PACKAGE="${MAINA_ANDROID_PACKAGE:-com.divay.maina}"
IOS_BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
PMD="${MAINA_PMD:-/Users/divay/Developer/.tools/maina-pymobiledevice3/bin/pymobiledevice3}"
ROOT="${MAINA_M0_EVIDENCE_ROOT:-$PROJECT_DIR/.artifacts/m0-replay}"
CURRENT_FILE="$ROOT/current"

android() { adb -s "$ANDROID_SERIAL" "$@"; }

preflight() {
  command -v adb >/dev/null
  command -v xcrun >/dev/null
  test -x "$PMD"

  android get-state >/dev/null
  local android_hardware android_version android_code ios_details ios_apps
  android_hardware="$(android shell getprop ro.serialno | tr -d '\r')"
  test "$android_hardware" = "47011FDAP000VE"
  android_version="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')"
  android_code="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk '/versionCode=/{sub(/^.*versionCode=/, ""); sub(/ .*/, ""); print; exit}' | tr -d '\r')"
  test -n "$android_version"

  ios_details="$(xcrun devicectl device info details --device "$IOS_COREDEVICE_ID" --timeout 15 2>/dev/null)"
  grep -q "marketingName: iPhone 15" <<<"$ios_details"
  grep -q "serialNumber: $IOS_SERIAL" <<<"$ios_details"
  grep -q "udid: $IOS_UDID" <<<"$ios_details"
  ios_apps="$(xcrun devicectl device info apps --device "$IOS_COREDEVICE_ID" --bundle-id "$IOS_BUNDLE_ID" --columns '*' --timeout 15 2>/dev/null)"
  grep -q "$IOS_BUNDLE_ID" <<<"$ios_apps"

  printf 'M0 replay preflight passed\n'
  printf 'Android: Pixel serial %s, Maina %s (%s)\n' "$android_hardware" "$android_version" "$android_code"
  printf 'iOS: iPhone 15 serial %s, bundle %s\n' "$IOS_SERIAL" "$IOS_BUNDLE_ID"
}

snapshot() {
  local output_dir="$1" label="$2"
  mkdir -p "$output_dir/snapshots"
  android shell dumpsys audio > "$output_dir/snapshots/${label}-android-audio.txt" 2>&1 || true
  android shell dumpsys notification --noredact > "$output_dir/snapshots/${label}-android-notifications.txt" 2>&1 || true
  android shell dumpsys activity services "$ANDROID_PACKAGE" > "$output_dir/snapshots/${label}-android-services.txt" 2>&1 || true
  android shell screencap -p > "$output_dir/snapshots/${label}-android.png" 2>/dev/null || true
  xcrun devicectl device info processes --device "$IOS_COREDEVICE_ID" --timeout 15 \
    > "$output_dir/snapshots/${label}-ios-processes.txt" 2>&1 || true
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$output_dir/snapshots/${label}-timestamp.txt"
}

case "$MODE" in
  preflight)
    preflight
    ;;
  arm)
    case "$TEST_NAME" in
      test3-call-interruption|test5-offline-recovery) ;;
      *) echo "Unknown replay: $TEST_NAME" >&2; exit 2 ;;
    esac
    preflight
    run_id="$(date '+%Y%m%d-%H%M%S')-$TEST_NAME"
    output_dir="$ROOT/$run_id"
    mkdir -p "$output_dir"
    printf '%s\n' "$output_dir" > "$CURRENT_FILE"
    printf 'test=%s\nstarted_at=%s\nandroid_serial=%s\nios_coredevice_id=%s\nios_udid=%s\n' \
      "$TEST_NAME" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$ANDROID_SERIAL" "$IOS_COREDEVICE_ID" "$IOS_UDID" \
      > "$output_dir/metadata.txt"
    android logcat -v threadtime -T 1 > "$output_dir/android-logcat.txt" 2>&1 &
    echo $! > "$output_dir/android-logcat.pid"
    "$PMD" syslog live --native --udid "$IOS_UDID" --process-name Maina --format json \
      --out "$output_dir/ios-syslog.ndjson" >/dev/null 2>&1 &
    echo $! > "$output_dir/ios-syslog.pid"
    snapshot "$output_dir" "armed"
    printf 'Replay armed: %s\nEvidence: %s\n' "$TEST_NAME" "$output_dir"
    ;;
  snapshot)
    test -f "$CURRENT_FILE"
    output_dir="$(cat "$CURRENT_FILE")"
    snapshot "$output_dir" "${TEST_NAME:-manual}-$(date '+%H%M%S')"
    printf 'Snapshot saved: %s\n' "$output_dir"
    ;;
  stop)
    test -f "$CURRENT_FILE"
    output_dir="$(cat "$CURRENT_FILE")"
    snapshot "$output_dir" "final"
    for pid_file in "$output_dir"/*.pid; do
      test -f "$pid_file" || continue
      pid="$(cat "$pid_file")"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    done
    printf 'stopped_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$output_dir/metadata.txt"
    printf 'Replay evidence closed: %s\n' "$output_dir"
    ;;
  *)
    echo "Usage: $0 preflight | arm <test3-call-interruption|test5-offline-recovery> | snapshot <label> | stop" >&2
    exit 2
    ;;
esac
