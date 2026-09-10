#!/system/bin/sh
# Temporary development bridge for the POPIO/AB Shutter3 remote.
# Run as Android's ADB shell user; it intentionally ends at phone reboot.

REQUESTED_DEVICE="${1:-auto}"
LOG_FILE="/data/local/tmp/maina-button-bridge.log"
PACKAGE="com.divay.maina"

log_line() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$1" >> "$LOG_FILE"
}

find_shutter_device() {
  if [ "$REQUESTED_DEVICE" != "auto" ] && [ -r "$REQUESTED_DEVICE" ]; then
    printf '%s\n' "$REQUESTED_DEVICE"
    return
  fi
  getevent -pl 2>/dev/null | awk '
    /add device [0-9]+:/ { path=$NF }
    /name: *"AB Shutter3"/ { print path; exit }
  '
}

maina_is_foreground() {
  dumpsys window 2>/dev/null | grep 'mCurrentFocus' | head -n 1 | grep -q "$PACKAGE"
}

maina_state() {
  title="$(dumpsys notification --noredact 2>/dev/null | awk -v package="$PACKAGE" '
    index($0, "pkg=" package) { found = 1 }
    found && /android.title=String/ {
      sub(/^.*android.title=String \(/, "")
      sub(/\)$/, "")
      print
      exit
    }
  ')"
  case "$title" in
    "Maina is ready") printf 'idle\n' ;;
    "Maina is recording") printf 'recording\n' ;;
    "Maina is paused") printf 'paused\n' ;;
    "Maina is saving") printf 'finalizing\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

wait_for_state_ack() {
  before="$1"
  command="$2"
  remaining=12
  while [ "$remaining" -gt 0 ]; do
    current="$(maina_state)"
    case "$command:$before:$current" in
      toggle:idle:recording|toggle:recording:paused|toggle:paused:recording|stop:recording:finalizing|stop:recording:idle|stop:paused:finalizing|stop:paused:idle) return 0 ;;
    esac
    sleep 1
    remaining=$((remaining - 1))
  done
  return 1
}

dispatch_maina_command() {
  command="$1"
  if ! dumpsys activity services "$PACKAGE" 2>/dev/null | grep -q 'MainaRecordingService'; then
    log_line "command=$command ignored=maina-service-not-armed"
    return
  fi
  if ! dumpsys package com.android.shell 2>/dev/null | grep -q 'android.permission.DUMP: granted=true'; then
    log_line "command=$command failed=shell-dump-unavailable"
    return
  fi
  before="$(maina_state)"
  case "$command:$before" in
    toggle:idle|toggle:recording|toggle:paused|stop:recording|stop:paused) ;;
    *) log_line "command=$command failed=state-not-commandable"; return ;;
  esac
  nonce="$(tr -d '-' < /proc/sys/kernel/random/uuid)"
  result="$(am broadcast \
    -n "$PACKAGE/com.divay.maina.recorder.MainaShellCommandReceiver" \
    -a com.divay.maina.recorder.SHELL_COMMAND \
    --es command "$command" \
    --es expectedState "$before" \
    --es nonce "$nonce" 2>&1)"
  completion="$(printf '%s\n' "$result" | awk '/^Broadcast completed:/{line=$0} END{print line}')"
  case "$completion" in
    *"result=17051"*"data=\"$nonce\""*) ;;
    *) log_line "command=$command failed=shell-ack"; return ;;
  esac
  if wait_for_state_ack "$before" "$command"; then
    log_line "command=$command accepted=maina-shell-control"
  else
    log_line "command=$command failed=state-ack"
  fi
}

log_line "started requested=$REQUESTED_DEVICE"

while true; do
  INPUT_DEVICE="$(find_shutter_device)"
  if [ -z "$INPUT_DEVICE" ] || [ ! -r "$INPUT_DEVICE" ]; then
    sleep 2
    continue
  fi

  log_line "attached device=$INPUT_DEVICE"
  while [ -r "$INPUT_DEVICE" ]; do
    # A long-lived getevent process buffers output when detached from a TTY on
    # this Pixel. One shutter press is six evdev records; bounded reads exit and
    # flush the complete press before dispatching it.
    event_batch="$(getevent -ql -c 6 "$INPUT_DEVICE" 2>/dev/null)"
    if [ -z "$event_batch" ]; then
      break
    fi
    case "$event_batch" in
      *EV_KEY*KEY_VOLUMEUP*UP*)
        if maina_is_foreground; then
          log_line "button=primary owner=activity-hid"
        else
          log_line "button=primary command=toggle owner=maina-shell-control"
          dispatch_maina_command toggle
        fi
        ;;
      *EV_KEY*KEY_VOLUMEDOWN*UP*)
        if maina_is_foreground; then
          log_line "button=secondary owner=activity-hid"
        else
          log_line "button=secondary command=stop owner=maina-shell-control"
          dispatch_maina_command stop
        fi
        ;;
    esac
  done
  log_line "detached device=$INPUT_DEVICE"
  sleep 1
done
