#!/usr/bin/env bash

maina_build_attempt_ensure_directory() {
  local directory="$1"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || return 78
  else
    mkdir -m 700 "$directory" 2>/dev/null || {
      [[ -d "$directory" && ! -L "$directory" ]] || return 78
    }
  fi
  chmod 700 "$directory" || return 78
  [[ "$(stat -f '%Lp' "$directory")" == "700" ]] || return 78
}
maina_build_attempt_write_exclusive() {
  local destination="$1"
  local payload="$2"
  (
    set -o noclobber
    umask 077
    printf '%s\n' "$payload" > "$destination"
  ) 2>/dev/null || return 75
  chmod 600 "$destination" || return 78
  [[ -f "$destination" && ! -L "$destination" && "$(stat -f '%Lp' "$destination")" == "600" ]] || return 78
}

maina_build_attempt_acquire() {
  local ledger_root="$1"
  local release_id="$2"
  local platform="$3"
  local source_commit="$4"
  local plan_sha256="$5"

  [[ "$ledger_root" == /* && ! -L "$ledger_root" ]] || return 78
  [[ "$release_id" =~ ^[a-z0-9][a-z0-9.-]{2,95}$ ]] || return 2
  [[ "$platform" == "android" || "$platform" == "ios" ]] || return 2
  [[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || return 2
  [[ "$plan_sha256" =~ ^[0-9a-f]{64}$ ]] || return 2

  maina_build_attempt_ensure_directory "$ledger_root" || return $?
  local release_root="$ledger_root/$release_id"
  maina_build_attempt_ensure_directory "$release_root" || return $?

  MAINA_BUILD_ATTEMPT_DIR="$release_root/$platform"
  MAINA_BUILD_ATTEMPT_RECONCILED=0
  if ! mkdir -m 700 "$MAINA_BUILD_ATTEMPT_DIR" 2>/dev/null; then
    return 75
  fi
  MAINA_BUILD_ATTEMPT_ACTIVE=1
  local payload
  payload="{\"schemaVersion\":\"maina.release-build-attempt.v1\",\"releaseId\":\"$release_id\",\"platform\":\"$platform\",\"sourceCommit\":\"$source_commit\",\"planSha256\":\"$plan_sha256\",\"state\":\"mutation_started\"}"
  maina_build_attempt_write_exclusive "$MAINA_BUILD_ATTEMPT_DIR/mutation-started.json" "$payload"
}

maina_build_attempt_terminal() {
  local state="$1"
  local reason_code="$2"
  [[ "${MAINA_BUILD_ATTEMPT_ACTIVE:-0}" == "1" ]] || return 78
  [[ "$state" == "terminal_success" || "$state" == "terminal_failure" ]] || return 2
  [[ "$reason_code" =~ ^[A-Z0-9_]{3,96}$ ]] || return 2
  local file_name
  if [[ "$state" == "terminal_success" ]]; then
    file_name="terminal-success.json"
  else
    file_name="terminal-failure.json"
  fi
  local payload
  payload="{\"schemaVersion\":\"maina.release-build-terminal.v1\",\"state\":\"$state\",\"reasonCode\":\"$reason_code\"}"
  maina_build_attempt_write_exclusive "$MAINA_BUILD_ATTEMPT_DIR/$file_name" "$payload" || return $?
  MAINA_BUILD_ATTEMPT_RECONCILED=1
}

maina_build_attempt_on_exit() {
  local status="$1"
  if [[ "${MAINA_BUILD_ATTEMPT_ACTIVE:-0}" == "1" && "${MAINA_BUILD_ATTEMPT_RECONCILED:-0}" != "1" ]]; then
    maina_build_attempt_write_exclusive \
      "$MAINA_BUILD_ATTEMPT_DIR/reconciliation-required.json" \
      '{"schemaVersion":"maina.release-build-terminal.v1","state":"reconciliation_required","reasonCode":"BUILD_OUTCOME_AMBIGUOUS"}' || true
  fi
  return "$status"
}
