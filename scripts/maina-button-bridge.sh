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
          log_line "button=primary command=toggle owner=bridge"
          am broadcast -a com.divay.maina.action.TOGGLE -p "$PACKAGE" >> "$LOG_FILE" 2>&1
        fi
        ;;
      *EV_KEY*KEY_VOLUMEDOWN*UP*)
        if maina_is_foreground; then
          log_line "button=secondary owner=activity-hid"
        else
          log_line "button=secondary command=stop owner=bridge"
          am broadcast -a com.divay.maina.action.STOP -p "$PACKAGE" >> "$LOG_FILE" 2>&1
        fi
        ;;
    esac
  done
  log_line "detached device=$INPUT_DEVICE"
  sleep 1
done
