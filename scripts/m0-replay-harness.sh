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

monitor_healthy() {
  local pid_file="$1" log_file="$2" label="$3"
  test -s "$pid_file" || { echo "$label PID file is missing" >&2; return 1; }
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null || { echo "$label monitor is not alive (PID $pid)" >&2; return 1; }
  test -s "$log_file" || { echo "$label log has not grown" >&2; return 1; }
}

verify_monitors() {
  local output_dir="$1"
  monitor_healthy "$output_dir/android-logcat.pid" "$output_dir/android-logcat.txt" "Android logcat"
  monitor_healthy "$output_dir/ios-syslog.pid" "$output_dir/ios-syslog.ndjson" "iOS syslog"
  printf '%s monitors_healthy\n' "$(date -Iseconds)" >> "$output_dir/monitor-supervisor.log"
}

stop_monitors() {
  local output_dir="$1"
  for pid_file in "$output_dir"/*.pid; do
    test -f "$pid_file" || continue
    local pid
    pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}

preflight() {
  command -v adb >/dev/null
  test -x "$PMD"

  android get-state >/dev/null
  local android_hardware android_version android_code ios_devices ios_apps
  android_hardware="$(android shell getprop ro.serialno | tr -d '\r')"
  test "$android_hardware" = "47011FDAP000VE"
  android_version="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')"
  android_code="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk '/versionCode=/{sub(/^.*versionCode=/, ""); sub(/ .*/, ""); print; exit}' | tr -d '\r')"
  test -n "$android_version"

  # CoreDevice can remain in a stale "connecting" state even while usbmux and
  # DeveloperTools services are healthy. Verify the exact physical USB device
  # and installed staging bundle through the same transport used for evidence.
  ios_devices="$("$PMD" usbmux list)"
  IOS_DEVICES="$ios_devices" IOS_UDID="$IOS_UDID" node -e '
    const devices = JSON.parse(process.env.IOS_DEVICES);
    const expected = devices.find((device) => device.Identifier === process.env.IOS_UDID);
    if (!expected || expected.ConnectionType !== "USB" || expected.ProductType !== "iPhone15,4") process.exit(1);
  '
  ios_apps="$("$PMD" apps query "$IOS_BUNDLE_ID" --udid "$IOS_UDID")"
  IOS_APPS="$ios_apps" IOS_BUNDLE_ID="$IOS_BUNDLE_ID" node -e '
    const apps = JSON.parse(process.env.IOS_APPS);
    const app = apps[process.env.IOS_BUNDLE_ID];
    if (!app || app.CFBundleShortVersionString !== "0.10.34" || app.CFBundleVersion !== "16") process.exit(1);
  '

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
  "$PMD" developer dvt screenshot "$output_dir/snapshots/${label}-ios.png" \
    --native --udid "$IOS_UDID" > "$output_dir/snapshots/${label}-ios-screenshot.txt" 2>&1 || true
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
    {
      printf '%s android_logcat_monitor_started\n' "$(date -Iseconds)"
      exec adb -s "$ANDROID_SERIAL" logcat -v threadtime -T 1
    } > "$output_dir/android-logcat.txt" 2>&1 &
    echo $! > "$output_dir/android-logcat.pid"
    {
      printf '%s ios_syslog_monitor_started\n' "$(date -Iseconds)"
      exec "$PMD" syslog live --native --udid "$IOS_UDID" --process-name Maina --format json
    } > "$output_dir/ios-syslog.ndjson" 2>&1 &
    echo $! > "$output_dir/ios-syslog.pid"
    trap 'stop_monitors "$output_dir"' ERR INT TERM
    sleep 2
    verify_monitors "$output_dir"
    snapshot "$output_dir" "armed"
    trap - ERR INT TERM
    printf 'Replay armed: %s\nEvidence: %s\n' "$TEST_NAME" "$output_dir"
    ;;
  health)
    test -f "$CURRENT_FILE"
    output_dir="$(cat "$CURRENT_FILE")"
    verify_monitors "$output_dir"
    printf 'Replay monitors healthy: %s\n' "$output_dir"
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
    verify_monitors "$output_dir"
    snapshot "$output_dir" "final"
    stop_monitors "$output_dir"
    printf 'stopped_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$output_dir/metadata.txt"
    printf 'Replay evidence closed: %s\n' "$output_dir"
    ;;
  *)
    echo "Usage: $0 preflight | arm <test3-call-interruption|test5-offline-recovery> | health | snapshot <label> | stop" >&2
    exit 2
    ;;
esac
