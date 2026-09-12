#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  echo "Usage: $0 <android|ios> preflight | arm <test3-call-interruption|test5-offline-recovery> | health | snapshot <label> | stop" >&2
}

LANE="${1:-}"
MODE="${2:-}"
TEST_NAME="${3:-}"
case "$LANE" in
  android|ios) ;;
  *) usage; exit 2 ;;
esac
case "$MODE" in
  preflight|health|stop)
    (( $# == 2 )) || { usage; exit 2; }
    ;;
  arm)
    (( $# == 3 )) || { usage; exit 2; }
    case "$TEST_NAME" in
      test3-call-interruption|test5-offline-recovery) ;;
      *) usage; exit 2 ;;
    esac
    ;;
  snapshot)
    (( $# == 3 )) || { usage; exit 2; }
    [[ "$TEST_NAME" =~ ^[A-Za-z0-9._-]{1,57}$ && "$TEST_NAME" != *..* ]] || { usage; exit 2; }
    ;;
  *) usage; exit 2 ;;
esac
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_SERIAL="${MAINA_ANDROID_SERIAL:-adb-47011FDAP000VE-9s0wNO._adb-tls-connect._tcp}"
IOS_COREDEVICE_ID="${MAINA_IOS_COREDEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
IOS_UDID="${MAINA_IOS_UDID:-00008120-001E146611E2601E}"
IOS_SERIAL="${MAINA_IOS_SERIAL:-MQLF6GV3XM}"
PROVENANCE="${MAINA_RELEASE_PROVENANCE:?Set MAINA_RELEASE_PROVENANCE to the Admin-approved dual-platform provenance}"
PLAN="$PROJECT_DIR/release/m3-m4-0.10.70-candidate-plan.json"
IFS=$'\t' read -r PROVENANCE_ANDROID_PACKAGE PROVENANCE_ANDROID_VERSION PROVENANCE_ANDROID_CODE \
  PROVENANCE_IOS_BUNDLE_ID PROVENANCE_IOS_VERSION PROVENANCE_IOS_BUILD \
  <<< "$(node "$PROJECT_DIR/scripts/release-provenance-cli.mjs" replay-config "$PLAN" "$PROVENANCE")"
ANDROID_PACKAGE="${MAINA_ANDROID_PACKAGE:-$PROVENANCE_ANDROID_PACKAGE}"
IOS_BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-$PROVENANCE_IOS_BUNDLE_ID}"
[[ "$ANDROID_PACKAGE" == "$PROVENANCE_ANDROID_PACKAGE" ]] || { echo "Android package override conflicts with approved provenance." >&2; exit 1; }
[[ "$IOS_BUNDLE_ID" == "$PROVENANCE_IOS_BUNDLE_ID" ]] || { echo "iOS bundle override conflicts with approved provenance." >&2; exit 1; }
XCRUN="${MAINA_XCRUN:-/usr/bin/xcrun}"
ROOT="${MAINA_M0_EVIDENCE_ROOT:-$PROJECT_DIR/.artifacts/m0-replay}"
CURRENT_FILE="$ROOT/current-$LANE"
LEGACY_CURRENT_FILE="$ROOT/current"

android() { adb -s "$ANDROID_SERIAL" "$@"; }

ios_runtime_identity_probe() (
  test -x "$XCRUN" || return 1
  local run_root capability_started_ms capability_completed_ms
  run_root="$(mktemp -d "${TMPDIR:-/tmp}/maina-m0-ios-runtime.XXXXXX")" || return 1
  trap 'rm -R -- "$run_root"' EXIT
  trap 'exit 130' HUP INT TERM
  chmod 700 "$run_root"
  "$XCRUN" devicectl list devices --json-output "$run_root/devices.json" \
    --quiet --timeout 10 >/dev/null 2>&1 || return 1
  capability_started_ms="$(node -p 'Date.now()')"
  "$XCRUN" devicectl device info processes --device "$IOS_COREDEVICE_ID" \
    --columns '*' --json-output "$run_root/processes.json" --quiet --timeout 15 \
    >/dev/null 2>&1 || return 1
  capability_completed_ms="$(node -p 'Date.now()')"
  "$XCRUN" devicectl device info apps --device "$IOS_COREDEVICE_ID" \
    --bundle-id "$IOS_BUNDLE_ID" --columns '*' --json-output "$run_root/apps.json" \
    --quiet --timeout 10 >/dev/null 2>&1 || return 1
  node --input-type=module - "$PROJECT_DIR/scripts/lib/renewal-core.mjs" \
    "$run_root/devices.json" "$run_root/processes.json" "$run_root/apps.json" \
    "$IOS_COREDEVICE_ID" "$IOS_UDID" "$IOS_BUNDLE_ID" \
    "$PROVENANCE_IOS_VERSION" \
    "$PROVENANCE_IOS_BUILD" "$capability_started_ms" "$capability_completed_ms" \
    >/dev/null 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const [
  , , renewalPath, devicesPath, processesPath, appsPath, deviceId, udid,
  bundleId, version, build, startedAtMs, completedAtMs,
] = process.argv;
const { findInstalledIosApp, findQualifiedIosDevice, validateInstalledIosArtifact } = await import(pathToFileURL(renewalPath));
const expected = { deviceId, udid, marketingName: 'iPhone 15', nowMs: Date.now() };
const proof = {
  schemaVersion: 'maina.ios-coredevice-capability-proof.v1',
  deviceId,
  operation: 'device-info-processes',
  timeoutMs: 15_000,
  startedAtMs: Number(startedAtMs),
  completedAtMs: Number(completedAtMs),
  exitCode: 0,
};
const device = findQualifiedIosDevice(JSON.parse(readFileSync(devicesPath, 'utf8')), expected, proof);
if (device.connectionProperties?.transportType !== 'wired') throw new Error('M0 requires exact wired transport.');
const payload = JSON.parse(readFileSync(appsPath, 'utf8'));
const matches = (payload?.result?.apps ?? []).filter((item) => item?.bundleIdentifier === bundleId);
if (matches.length !== 1) throw new Error('Installed iOS app cardinality mismatch.');
const installed = findInstalledIosApp(payload, bundleId);
validateInstalledIosArtifact(installed, { bundleId, version, build });
const app = matches[0];
if (app.name !== 'Maina' || typeof app.url !== 'string') throw new Error('Installed iOS app runtime identity is invalid.');
const appUrl = new URL(app.url);
if (appUrl.protocol !== 'file:' || appUrl.username || appUrl.password || appUrl.search || appUrl.hash) {
  throw new Error('Installed iOS app runtime URL is invalid.');
}
const appPath = fileURLToPath(appUrl);
if (!appPath.endsWith('/Maina.app/')) throw new Error('Installed iOS app runtime path is invalid.');
const expectedExecutable = path.posix.join(appPath, 'Maina');
const processPayload = JSON.parse(readFileSync(processesPath, 'utf8'));
const processMatches = (processPayload?.result?.runningProcesses ?? []).filter((item) => (
  item?.executable === expectedExecutable
  && Number.isSafeInteger(item.processIdentifier)
  && item.processIdentifier > 0
));
if (processMatches.length !== 1) throw new Error('Running iOS app process cardinality mismatch.');
NODE
)

current_output_dir() {
  test -s "$CURRENT_FILE" || return 1
  local run_id
  run_id="$(cat "$CURRENT_FILE")"
  [[ "$run_id" =~ ^[0-9]{8}-[0-9]{6}-${LANE}-(test3-call-interruption|test5-offline-recovery)$ ]] || return 1
  printf '%s/%s\n' "$ROOT" "$run_id"
}

active_run_exists() {
  [[ -e "$CURRENT_FILE" || -L "$CURRENT_FILE" ]] || return 1
  [[ -f "$CURRENT_FILE" && ! -L "$CURRENT_FILE" ]] || return 0
  local previous_dir
  previous_dir="$(current_output_dir)" || return 0
  test -d "$previous_dir" || return 0
  grep -q '^stopped_at=' "$previous_dir/metadata.txt" 2>/dev/null && return 1
  for pid_file in "$previous_dir"/*.pid; do
    test -s "$pid_file" || continue
    kill -0 "$(cat "$pid_file")" 2>/dev/null && return 0
  done
  return 0
}

legacy_current_blocks_arm() {
  [[ -e "$LEGACY_CURRENT_FILE" || -L "$LEGACY_CURRENT_FILE" ]]
}

monitor_healthy() {
  local pid_file="$1" log_file="$2" label="$3"
  test -s "$pid_file" || { echo "$label PID file is missing" >&2; return 1; }
  local pid
  pid="$(cat "$pid_file")"
  kill -0 "$pid" 2>/dev/null || { echo "$label monitor is not alive" >&2; return 1; }
  test -s "$log_file" || { echo "$label log has not grown" >&2; return 1; }
  local last_sample sample_epoch now_epoch sample_age
  last_sample="$(tail -n 1 "$log_file")"
  [[ "$last_sample" =~ ^[^[:space:]]+[[:space:]]lane=(android|ios)[[:space:]]observer_status=PASS[[:space:]]sample_epoch=([0-9]+)$ ]] \
    || { echo "$label reports an unavailable endpoint" >&2; return 1; }
  sample_epoch="${BASH_REMATCH[2]}"
  now_epoch="$(date +%s)"
  [[ "$now_epoch" =~ ^[0-9]+$ ]] || { echo "$label freshness clock is invalid" >&2; return 1; }
  sample_age=$((now_epoch - sample_epoch))
  (( sample_age >= 0 && sample_age <= 45 )) \
    || { echo "$label last successful sample is stale" >&2; return 1; }
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
        if ios_runtime_identity_probe; then
          status="PASS"
        fi
        ;;
    esac
    printf '%s lane=%s observer_status=%s sample_epoch=%s\n' \
      "$(date -Iseconds)" "$LANE" "$status" "$(date +%s)"
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

preflight_ios() (
  test -x "$XCRUN" || { echo "M0_IOS_COREDEVICE_TOOL_UNAVAILABLE" >&2; return 1; }
  local run_root capability_started_ms capability_completed_ms preflight_status=0
  run_root="$(mktemp -d "${TMPDIR:-/tmp}/maina-m0-ios-preflight.XXXXXX")" \
    || { echo "M0_IOS_PRIVATE_TEMP_UNAVAILABLE" >&2; return 1; }
  trap 'rm -R -- "$run_root"' EXIT
  trap 'exit 130' HUP INT TERM
  chmod 700 "$run_root"

  capability_started_ms="$(node -p 'Date.now()')"
  if ! "$XCRUN" devicectl device info processes --device "$IOS_COREDEVICE_ID" \
    --timeout 15 --quiet >/dev/null 2>&1; then
    echo "M0_IOS_CAPABILITY_PROOF_FAILED" >&2
    preflight_status=1
  fi
  capability_completed_ms="$(node -p 'Date.now()')"

  if [[ "$preflight_status" == "0" ]] \
    && ! "$XCRUN" devicectl list devices --json-output "$run_root/devices.json" \
      --quiet --timeout 10 >/dev/null 2>&1; then
    echo "M0_IOS_DEVICE_LIST_FAILED" >&2
    preflight_status=1
  fi
  if [[ "$preflight_status" == "0" ]] \
    && ! "$XCRUN" devicectl device info apps --device "$IOS_COREDEVICE_ID" \
      --bundle-id "$IOS_BUNDLE_ID" --columns '*' --json-output "$run_root/apps.json" \
      --quiet --timeout 10 >/dev/null 2>&1; then
    echo "M0_IOS_APP_QUERY_FAILED" >&2
    preflight_status=1
  fi

  if [[ "$preflight_status" == "0" ]] && ! node --input-type=module - \
    "$PROJECT_DIR/scripts/lib/renewal-core.mjs" "$run_root/devices.json" "$run_root/apps.json" \
    "$IOS_COREDEVICE_ID" "$IOS_UDID" "$IOS_BUNDLE_ID" \
    "$PROVENANCE_IOS_VERSION" "$PROVENANCE_IOS_BUILD" \
    "$capability_started_ms" "$capability_completed_ms" >/dev/null 2>&1 <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [
  , , renewalPath, devicesPath, appsPath, deviceId, udid, bundleId,
  version, build, startedAtMs, completedAtMs,
] = process.argv;
const { findInstalledIosApp, findQualifiedIosDevice, validateInstalledIosArtifact } = await import(pathToFileURL(renewalPath));
const expected = { deviceId, udid, marketingName: 'iPhone 15', nowMs: Date.now() };
const proof = {
  schemaVersion: 'maina.ios-coredevice-capability-proof.v1',
  deviceId,
  operation: 'device-info-processes',
  timeoutMs: 15_000,
  startedAtMs: Number(startedAtMs),
  completedAtMs: Number(completedAtMs),
  exitCode: 0,
};
const device = findQualifiedIosDevice(JSON.parse(readFileSync(devicesPath, 'utf8')), expected, proof);
if (device.connectionProperties?.transportType !== 'wired') throw new Error('M0 requires exact wired transport.');
const appsPayload = JSON.parse(readFileSync(appsPath, 'utf8'));
const matches = (appsPayload?.result?.apps ?? []).filter((item) => item?.bundleIdentifier === bundleId);
if (matches.length !== 1) throw new Error('Installed iOS app cardinality mismatch.');
const installed = findInstalledIosApp(appsPayload, bundleId);
validateInstalledIosArtifact(installed, { bundleId, version, build });
NODE
  then
    echo "M0_IOS_IDENTITY_REJECTED" >&2
    preflight_status=1
  fi

  [[ "$preflight_status" == "0" ]] || return "$preflight_status"
  printf 'M0 iOS replay preflight passed for the approved CoreDevice, bundle, and artifact identity.\n'
)

preflight() {
  case "$LANE" in
    android) preflight_android ;;
    ios) preflight_ios ;;
  esac
}

snapshot() {
  local output_dir="$1" label="$2"
  [[ "$label" =~ ^[A-Za-z0-9._-]{1,64}$ && "$label" != *..* ]] || {
    echo "Snapshot label is invalid." >&2
    return 2
  }
  [[ ! -L "$output_dir/snapshots" ]] || {
    echo "Snapshot evidence directory is invalid." >&2
    return 2
  }
  mkdir -p "$output_dir/snapshots"
  [[ -d "$output_dir/snapshots" && ! -L "$output_dir/snapshots" ]] || {
    echo "Snapshot evidence directory is invalid." >&2
    return 2
  }
  local status_path="$output_dir/snapshots/${label}-${LANE}-status.txt"
  local timestamp_path="$output_dir/snapshots/${label}-timestamp.txt"
  if [[ -e "$status_path" || -L "$status_path" || -e "$timestamp_path" || -L "$timestamp_path" ]]; then
    echo "Snapshot evidence already exists; refusing to overwrite it." >&2
    return 2
  fi
  local audio_status="FAIL" notification_status="FAIL" app_status="FAIL"
  case "$LANE" in
    android)
      android shell dumpsys audio >/dev/null 2>&1 && audio_status="PASS"
      android shell dumpsys notification >/dev/null 2>&1 && notification_status="PASS"
      android shell pidof "$ANDROID_PACKAGE" >/dev/null 2>&1 && app_status="PASS"
      if ! (set -o noclobber; printf 'schemaVersion=maina.m0-sanitized-snapshot.v1\nlane=android\naudio_probe=%s\nnotification_probe=%s\napp_process_probe=%s\n' \
        "$audio_status" "$notification_status" "$app_status" > "$status_path"); then
        echo "Snapshot evidence creation failed closed." >&2
        return 2
      fi
      ;;
    ios)
      ios_runtime_identity_probe && app_status="PASS"
      if ! (set -o noclobber; printf 'schemaVersion=maina.m0-sanitized-snapshot.v1\nlane=ios\napp_endpoint_probe=%s\n' \
        "$app_status" > "$status_path"); then
        echo "Snapshot evidence creation failed closed." >&2
        return 2
      fi
      ;;
  esac
  if ! (set -o noclobber; date -u '+%Y-%m-%dT%H:%M:%SZ' > "$timestamp_path"); then
    echo "Snapshot timestamp creation failed closed." >&2
    return 2
  fi
  if [[ "$LANE" == "ios" && "$app_status" != "PASS" ]]; then
    echo "iOS snapshot reports an unavailable or mismatched installed app endpoint." >&2
    return 1
  fi
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
    if legacy_current_blocks_arm; then
      echo "Refusing to arm while a legacy replay pointer exists. Reconcile it explicitly first." >&2
      exit 1
    fi
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
