#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="${MAINA_PACKAGE:-com.divay.maina}"
DURATION_SECONDS="${1:-10800}"
POST_STOP_SECONDS="${MAINA_POST_STOP_SECONDS:-2700}"
START_WAIT_SECONDS="${MAINA_START_WAIT_SECONDS:-900}"
ADB="${ADB:-$(command -v adb || true)}"
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
OUTPUT_DIR="${MAINA_SOAK_OUTPUT_DIR:-$PROJECT_DIR/.artifacts/soak/$RUN_ID}"
DEVICE_STOP_LOG="/data/local/tmp/maina-soak-stop-$RUN_ID.log"
LOGCAT_PID=""
CAFFEINATE_PID=""

case "$DURATION_SECONDS:$POST_STOP_SECONDS:$START_WAIT_SECONDS" in
  *[!0-9:]*|:*|*::*|*:)
    echo "Durations must be positive integer seconds." >&2
    exit 2
    ;;
esac
if (( DURATION_SECONDS <= 0 || POST_STOP_SECONDS <= 0 || START_WAIT_SECONDS <= 0 )); then
  echo "Durations must be greater than zero." >&2
  exit 2
fi

if [[ -z "$ADB" || ! -x "$ADB" ]]; then
  echo "adb was not found. Set ADB=/absolute/path/to/adb." >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR"

cleanup() {
  if [[ -n "$LOGCAT_PID" ]]; then
    kill "$LOGCAT_PID" 2>/dev/null || true
    wait "$LOGCAT_PID" 2>/dev/null || true
  fi
  if [[ -n "$CAFFEINATE_PID" ]]; then
    kill "$CAFFEINATE_PID" 2>/dev/null || true
    wait "$CAFFEINATE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

adb_shell() {
  "$ADB" shell "$@"
}

notification_title() {
  adb_shell dumpsys notification --noredact 2>/dev/null | awk -v package="$PACKAGE" '
    index($0, "pkg=" package) { found = 1 }
    found && /android.title=String/ {
      sub(/^.*android.title=String \(/, "")
      sub(/\)$/, "")
      print
      exit
    }
  '
}

notification_text() {
  adb_shell dumpsys notification --noredact 2>/dev/null | awk -v package="$PACKAGE" '
    index($0, "pkg=" package) { found = 1 }
    found && /android.text=String/ {
      sub(/^.*android.text=String \(/, "")
      sub(/\)$/, "")
      print
      exit
    }
  '
}

snapshot() {
  local phase="$1"
  local now battery level temperature voltage available_kb pid pss title text audio_mode
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  battery="$(adb_shell dumpsys battery 2>/dev/null || true)"
  level="$(printf '%s\n' "$battery" | awk '/level:/{print $2; exit}')"
  temperature="$(printf '%s\n' "$battery" | awk '/temperature:/{print $2; exit}')"
  voltage="$(printf '%s\n' "$battery" | awk '/voltage:/{print $2; exit}')"
  available_kb="$(adb_shell df -k /data/user/0 2>/dev/null | awk 'NR==2 {print $4}')"
  pid="$(adb_shell pidof "$PACKAGE" 2>/dev/null | awk '{print $1}')"
  if [[ -n "$pid" ]]; then
    pss="$(adb_shell dumpsys meminfo "$pid" 2>/dev/null | awk '/TOTAL PSS:/{print $3; exit}')"
  else
    pss=""
  fi
  title="$(notification_title || true)"
  text="$(notification_text || true)"
  audio_mode="$(adb_shell cmd appops get "$PACKAGE" RECORD_AUDIO 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$now" "$phase" "$level" "$temperature" "$voltage" "$available_kb" "$pid" "$pss" "$title" "$text" "$audio_mode" \
    >> "$OUTPUT_DIR/heartbeat.tsv"
}

wait_for_device_until() {
  local deadline="$1"
  while (( $(date +%s) < deadline )); do
    if "$ADB" get-state >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

send_stop() {
  "$ADB" shell am broadcast -a com.divay.maina.action.STOP -p "$PACKAGE" \
    >> "$OUTPUT_DIR/stop-broadcasts.txt" 2>&1 || true
}

if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "No ADB device is connected." >&2
  exit 2
fi

VERSION_NAME="$(adb_shell dumpsys package "$PACKAGE" | awk -F= '/versionName=/{print $2; exit}')"
VERSION_CODE="$(adb_shell dumpsys package "$PACKAGE" | awk '/versionCode=/{sub(/^.*versionCode=/, ""); sub(/ .*/, ""); print; exit}')"
ACCESSIBILITY="$(adb_shell settings get secure enabled_accessibility_services 2>/dev/null || true)"
SERVICE_STATE="$(adb_shell dumpsys activity services "$PACKAGE" 2>/dev/null || true)"

if [[ -z "$VERSION_NAME" ]]; then
  echo "Maina is not installed on the connected device." >&2
  exit 2
fi
if [[ "$ACCESSIBILITY" != *"$PACKAGE/com.divay.maina.recorder.MainaKeyAccessibilityService"* ]]; then
  echo "Maina Accessibility is not enabled; locked-screen clicker start is not ready." >&2
  exit 2
fi
if [[ "$SERVICE_STATE" != *"MainaRecordingService"* || "$SERVICE_STATE" != *"isForeground=true"* ]]; then
  echo "Maina is not armed as a foreground service. Open Maina once, then retry." >&2
  exit 2
fi

if [[ "${MAINA_PREFLIGHT_ONLY:-0}" == "1" ]]; then
  printf 'Maina soak preflight passed\n'
  printf 'Version: %s (%s)\n' "$VERSION_NAME" "$VERSION_CODE"
  printf 'Device: %s · Android %s\n' "$(adb_shell getprop ro.product.model)" "$(adb_shell getprop ro.build.version.release)"
  printf 'State: %s\n' "$(notification_title || true)"
  printf 'Accessibility: enabled\n'
  printf 'Evidence directory when started: %s\n' "$OUTPUT_DIR"
  exit 0
fi

printf '%s\n' \
  "run_id=$RUN_ID" \
  "package=$PACKAGE" \
  "version_name=$VERSION_NAME" \
  "version_code=$VERSION_CODE" \
  "duration_seconds=$DURATION_SECONDS" \
  "post_stop_seconds=$POST_STOP_SECONDS" \
  "started_monitor_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "device=$(adb_shell getprop ro.product.model)" \
  "android=$(adb_shell getprop ro.build.version.release)" \
  "output_dir=$OUTPUT_DIR" \
  > "$OUTPUT_DIR/metadata.txt"

printf 'timestamp_utc\tphase\tbattery_pct\ttemperature_tenths_c\tvoltage_mv\tdata_available_kb\tmain_pid\ttotal_pss_kb\tnotification_title\tnotification_text\trecord_audio_appop\n' \
  > "$OUTPUT_DIR/heartbeat.tsv"

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -dimsu -w "$$" >/dev/null 2>&1 &
  CAFFEINATE_PID=$!
fi

"$ADB" logcat -c
"$ADB" logcat -v threadtime > "$OUTPUT_DIR/logcat.txt" 2>&1 &
LOGCAT_PID=$!
adb_shell dumpsys batterystats --reset > "$OUTPUT_DIR/batterystats-reset.txt" 2>&1 || true
snapshot "waiting-for-clicker-start"

echo "Soak monitor ready. Output: $OUTPUT_DIR"
echo "Start Maina with the primary clicker button. Waiting up to $START_WAIT_SECONDS seconds."

wait_deadline=$(( $(date +%s) + START_WAIT_SECONDS ))
while (( $(date +%s) < wait_deadline )); do
  title="$(notification_title || true)"
  if [[ "$title" == "Maina is recording" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(notification_title || true)" != "Maina is recording" ]]; then
  snapshot "start-timeout"
  echo "Maina did not reach recording state before the start timeout." >&2
  exit 3
fi

recording_started_epoch="$(date +%s)"
recording_deadline=$(( recording_started_epoch + DURATION_SECONDS ))
printf 'recording_started_at=%s\nrecording_deadline_at=%s\n' \
  "$(date -u -r "$recording_started_epoch" '+%Y-%m-%dT%H:%M:%SZ')" \
  "$(date -u -r "$recording_deadline" '+%Y-%m-%dT%H:%M:%SZ')" \
  >> "$OUTPUT_DIR/metadata.txt"

# Redundant device-local stop timer. The Mac sends the same idempotent command
# at the deadline, but this survives a temporary wireless-ADB disconnect.
adb_shell "nohup sh -c 'sleep $DURATION_SECONDS; am broadcast -a com.divay.maina.action.STOP -p $PACKAGE' >'$DEVICE_STOP_LOG' 2>&1 </dev/null &" \
  > "$OUTPUT_DIR/device-stop-schedule.txt" 2>&1 || true

snapshot "recording-started"
echo "Recording detected. Stop-and-save is scheduled for $(date -r "$recording_deadline" '+%Y-%m-%d %H:%M:%S %Z')."

while (( $(date +%s) < recording_deadline )); do
  sleep 60
  if "$ADB" get-state >/dev/null 2>&1; then
    snapshot "recording"
    title="$(notification_title || true)"
    if [[ "$title" != "Maina is recording" ]]; then
      printf 'recording_ended_early_at=%s\nrecording_ended_early_state=%s\n' \
        "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$title" >> "$OUTPUT_DIR/metadata.txt"
      echo "Recording left the recording state before the planned deadline: $title" >&2
      exit 4
    fi
  else
    printf '%s\trecording-adb-disconnected\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$OUTPUT_DIR/heartbeat.tsv"
  fi
done

reconnect_deadline=$(( $(date +%s) + 300 ))
if wait_for_device_until "$reconnect_deadline"; then
  send_stop
fi

stop_wait_deadline=$(( $(date +%s) + 600 ))
while (( $(date +%s) < stop_wait_deadline )); do
  if "$ADB" get-state >/dev/null 2>&1; then
    snapshot "stopping"
    title="$(notification_title || true)"
    if [[ "$title" == "Maina is ready" ]]; then
      break
    fi
    if [[ "$title" == "Maina is recording" || "$title" == "Maina is paused" ]]; then
      send_stop
    fi
  fi
  sleep 15
done

if [[ "$(notification_title || true)" != "Maina is ready" ]]; then
  snapshot "stop-timeout"
  echo "Stop-and-save did not return Maina to ready state within 10 minutes." >&2
  exit 5
fi

snapshot "recording-stopped"
echo "Recording stopped safely. Observing transcription/packet work for $POST_STOP_SECONDS more seconds."

post_deadline=$(( $(date +%s) + POST_STOP_SECONDS ))
while (( $(date +%s) < post_deadline )); do
  sleep 60
  if "$ADB" get-state >/dev/null 2>&1; then
    snapshot "post-processing"
  else
    printf '%s\tpost-processing-adb-disconnected\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$OUTPUT_DIR/heartbeat.tsv"
  fi
done

if "$ADB" get-state >/dev/null 2>&1; then
  snapshot "complete"
  adb_shell dumpsys batterystats > "$OUTPUT_DIR/batterystats-final.txt" 2>&1 || true
  adb_shell dumpsys activity services "$PACKAGE" > "$OUTPUT_DIR/services-final.txt" 2>&1 || true
  adb_shell dumpsys notification --noredact > "$OUTPUT_DIR/notifications-final.txt" 2>&1 || true
  adb_shell cat "$DEVICE_STOP_LOG" > "$OUTPUT_DIR/device-stop-final.txt" 2>&1 || true
fi

printf 'completed_at=%s\nresult=monitor-complete\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$OUTPUT_DIR/metadata.txt"
echo "Soak monitor complete. Evidence: $OUTPUT_DIR"
