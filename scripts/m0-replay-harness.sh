#!/usr/bin/env bash
set -euo pipefail

LANE="${1:-}"
MODE="${2:-preflight}"
TEST_NAME="${3:-test3-call-interruption}"
case "$LANE" in
  android|ios) ;;
  *) echo "Usage: $0 <android|ios> preflight | arm <test3-call-interruption|test5-offline-recovery> | health | snapshot <label> | stop" >&2; exit 2 ;;
esac
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_SERIAL="${MAINA_ANDROID_SERIAL:-adb-47011FDAP000VE-9s0wNO._adb-tls-connect._tcp}"
IOS_COREDEVICE_ID="${MAINA_IOS_COREDEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
IOS_UDID="${MAINA_IOS_UDID:-00008120-001E146611E2601E}"
IOS_SERIAL="${MAINA_IOS_SERIAL:-MQLF6GV3XM}"
PROVENANCE="${MAINA_RELEASE_PROVENANCE:?Set MAINA_RELEASE_PROVENANCE to the Admin-approved dual-platform provenance}"
PLAN="$PROJECT_DIR/release/m3-m4-0.10.51-candidate-plan.json"
IFS=$'\t' read -r PROVENANCE_ANDROID_PACKAGE PROVENANCE_ANDROID_VERSION PROVENANCE_ANDROID_CODE \
  PROVENANCE_IOS_BUNDLE_ID PROVENANCE_IOS_VERSION PROVENANCE_IOS_BUILD \
  <<< "$(node "$PROJECT_DIR/scripts/release-provenance-cli.mjs" replay-config "$PLAN" "$PROVENANCE")"
ANDROID_PACKAGE="${MAINA_ANDROID_PACKAGE:-$PROVENANCE_ANDROID_PACKAGE}"
IOS_BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-$PROVENANCE_IOS_BUNDLE_ID}"
[[ "$ANDROID_PACKAGE" == "$PROVENANCE_ANDROID_PACKAGE" ]] || { echo "Android package override conflicts with approved provenance." >&2; exit 1; }
[[ "$IOS_BUNDLE_ID" == "$PROVENANCE_IOS_BUNDLE_ID" ]] || { echo "iOS bundle override conflicts with approved provenance." >&2; exit 1; }
PMD="${MAINA_PMD:-/Users/divay/Developer/.tools/maina-pymobiledevice3/bin/pymobiledevice3}"
ROOT="${MAINA_M0_EVIDENCE_ROOT:-$PROJECT_DIR/.artifacts/m0-replay}"
CURRENT_FILE="$ROOT/current-$LANE"

android() { adb -s "$ANDROID_SERIAL" "$@"; }

current_output_dir() {
  test -s "$CURRENT_FILE" || return 1
  local run_id
  run_id="$(cat "$CURRENT_FILE")"
  [[ "$run_id" =~ ^[0-9]{8}-[0-9]{6}-(android|ios)-(test3-call-interruption|test5-offline-recovery)$ ]] || return 1
  printf '%s/%s\n' "$ROOT" "$run_id"
}

active_run_exists() {
  local previous_dir
  previous_dir="$(current_output_dir)" || return 1
  test -d "$previous_dir" || return 1
  grep -q '^stopped_at=' "$previous_dir/metadata.txt" 2>/dev/null && return 1
  for pid_file in "$previous_dir"/*.pid; do
    test -s "$pid_file" || continue
    kill -0 "$(cat "$pid_file")" 2>/dev/null && return 0
  done
  return 1
}

monitor_healthy() {
  local pid_file="$1" log_file="$2" label="$3"
  test -s "$pid_file" || { echo "$label PID file is missing" >&2; return 1; }
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null || { echo "$label monitor is not alive" >&2; return 1; }
  test -s "$log_file" || { echo "$label log has not grown" >&2; return 1; }
  tail -n 1 "$log_file" | grep -q 'observer_status=PASS$' \
    || { echo "$label reports an unavailable endpoint" >&2; return 1; }
}

monitor_lane_health() {
  local sample_count=0 status
  while true; do
    status="FAIL"
    case "$LANE" in
      android)
        if android get-state >/dev/null 2>&1 \
          && android shell pidof "$ANDROID_PACKAGE" >/dev/null 2>&1; then
          status="PASS"
        fi
        ;;
      ios)
        if "$PMD" apps query "$IOS_BUNDLE_ID" --udid "$IOS_UDID" >/dev/null 2>&1; then
          status="PASS"
        fi
        ;;
    esac
    printf '%s lane=%s observer_status=%s\n' "$(date -Iseconds)" "$LANE" "$status"
    sample_count=$((sample_count + 1))
    (( sample_count < 720 )) || return 3
    sleep 5
  done
}

verify_monitors() {
  local output_dir="$1"
  case "$LANE" in
    android) monitor_healthy "$output_dir/android-observer.pid" "$output_dir/android-observer.log" "Android observer" ;;
    ios) monitor_healthy "$output_dir/ios-observer.pid" "$output_dir/ios-observer.log" "iOS observer" ;;
  esac
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

preflight_android() {
  command -v adb >/dev/null

  [[ "$ANDROID_SERIAL" == *"._adb-tls-connect._tcp" ]] || {
    echo "M0 replay requires the pinned Wi-Fi ADB endpoint, not USB or an emulator." >&2
    return 1
  }
  local matching_targets
  matching_targets="$(adb devices | awk -v serial="$ANDROID_SERIAL" 'NR > 1 && $1 == serial && $2 == "device" { count += 1 } END { print count + 0 }')"
  test "$matching_targets" = "1"
  android get-state >/dev/null
  local android_hardware android_model android_version android_code
  android_hardware="$(android shell getprop ro.serialno | tr -d '\r')"
  test "$android_hardware" = "47011FDAP000VE"
  android_model="$(android shell getprop ro.product.model | tr -d '\r')"
  test "$android_model" = "Pixel 9 Pro"
  android_version="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')"
  android_code="$(android shell dumpsys package "$ANDROID_PACKAGE" | awk '/versionCode=/{sub(/^.*versionCode=/, ""); sub(/ .*/, ""); print; exit}' | tr -d '\r')"
  [[ "$android_version" == "$PROVENANCE_ANDROID_VERSION" && "$android_code" == "$PROVENANCE_ANDROID_CODE" ]] || {
    echo "Installed Android release does not match approved provenance: $android_version ($android_code)." >&2
    return 1
  }

  printf 'M0 Android replay preflight passed for the approved package and artifact identity.\n'
}

preflight_ios() {
  test -x "$PMD"
  local ios_devices ios_apps
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
  IOS_APPS="$ios_apps" IOS_BUNDLE_ID="$IOS_BUNDLE_ID" \
    PROVENANCE_IOS_VERSION="$PROVENANCE_IOS_VERSION" PROVENANCE_IOS_BUILD="$PROVENANCE_IOS_BUILD" node -e '
    const apps = JSON.parse(process.env.IOS_APPS);
    const app = apps[process.env.IOS_BUNDLE_ID];
    if (!app
      || app.CFBundleShortVersionString !== process.env.PROVENANCE_IOS_VERSION
      || app.CFBundleVersion !== process.env.PROVENANCE_IOS_BUILD) process.exit(1);
  '

  printf 'M0 iOS replay preflight passed for the approved bundle and artifact identity.\n'
}

preflight() {
  case "$LANE" in
    android) preflight_android ;;
    ios) preflight_ios ;;
  esac
}

snapshot() {
  local output_dir="$1" label="$2"
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ && "$label" != *..* ]] || {
    echo "Snapshot label is invalid." >&2
    return 2
  }
  mkdir -p "$output_dir/snapshots"
  local audio_status="FAIL" notification_status="FAIL" app_status="FAIL"
  case "$LANE" in
    android)
      android shell dumpsys audio >/dev/null 2>&1 && audio_status="PASS"
      android shell dumpsys notification >/dev/null 2>&1 && notification_status="PASS"
      android shell pidof "$ANDROID_PACKAGE" >/dev/null 2>&1 && app_status="PASS"
      printf 'schemaVersion=maina.m0-sanitized-snapshot.v1\nlane=android\naudio_probe=%s\nnotification_probe=%s\napp_process_probe=%s\n' \
        "$audio_status" "$notification_status" "$app_status" \
        > "$output_dir/snapshots/${label}-android-status.txt"
      ;;
    ios)
      "$PMD" apps query "$IOS_BUNDLE_ID" --udid "$IOS_UDID" >/dev/null 2>&1 && app_status="PASS"
      printf 'schemaVersion=maina.m0-sanitized-snapshot.v1\nlane=ios\napp_endpoint_probe=%s\n' \
        "$app_status" > "$output_dir/snapshots/${label}-ios-status.txt"
      ;;
  esac
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
    if active_run_exists; then
      echo "Refusing to arm over an active replay. Stop the current replay explicitly first." >&2
      exit 1
    fi
    preflight
    run_id="$(date '+%Y%m%d-%H%M%S')-$LANE-$TEST_NAME"
    output_dir="$ROOT/$run_id"
    mkdir -p "$output_dir"
    printf '%s\n' "$run_id" > "$CURRENT_FILE"
    printf 'test=%s\nlane=%s\nstarted_at=%s\n' \
      "$TEST_NAME" "$LANE" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$output_dir/metadata.txt"
    case "$LANE" in
      android)
        {
          printf '%s android_sanitized_observer_started\n' "$(date -Iseconds)"
          monitor_lane_health
        } > "$output_dir/android-observer.log" 2>/dev/null &
        echo $! > "$output_dir/android-observer.pid"
        ;;
      ios)
        {
          printf '%s ios_sanitized_observer_started\n' "$(date -Iseconds)"
          monitor_lane_health
        } > "$output_dir/ios-observer.log" 2>/dev/null &
        echo $! > "$output_dir/ios-observer.pid"
        ;;
    esac
    trap 'stop_monitors "$output_dir"' ERR INT TERM
    sleep 2
    verify_monitors "$output_dir"
    snapshot "$output_dir" "armed"
    trap - ERR INT TERM
    printf 'Replay armed: %s\nEvidence run: %s\n' "$TEST_NAME" "$run_id"
    ;;
  health)
    output_dir="$(current_output_dir)"
    verify_monitors "$output_dir"
    printf 'Replay monitors healthy for lane: %s\n' "$LANE"
    ;;
  snapshot)
    output_dir="$(current_output_dir)"
    snapshot "$output_dir" "${TEST_NAME:-manual}-$(date '+%H%M%S')"
    printf 'Snapshot saved for lane: %s\n' "$LANE"
    ;;
  stop)
    output_dir="$(current_output_dir)"
    monitor_status=0
    verify_monitors "$output_dir" || monitor_status=$?
    snapshot "$output_dir" "final" || monitor_status=$?
    stop_monitors "$output_dir"
    printf 'stopped_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$output_dir/metadata.txt"
    printf 'Replay evidence closed for lane: %s\n' "$LANE"
    exit "$monitor_status"
    ;;
  *)
    echo "Usage: $0 <android|ios> preflight | arm <test3-call-interruption|test5-offline-recovery> | health | snapshot <label> | stop" >&2
    exit 2
    ;;
esac
