#!/usr/bin/env bash
# Bind Maina build scripts to the independently audited external-storage guard.
# This adapter intentionally does not duplicate disk, filesystem, or marker logic.

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "Maina storage binding requires Bash." >&2
  return 78 2>/dev/null || exit 78
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file from a Maina build script." >&2
  exit 78
fi

MAINA_STORAGE_GUARD='/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh'
MAINA_STORAGE_GUARD_SHA256='e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f'
MAINA_STORAGE_GUARD_BYTES='3387'
MAINA_STORAGE_GUARD_MODE='755'
MAINA_STORAGE_EXPECTED_ROOT='/Volumes/DivaySSD/MainaBuild'

maina_storage_fail() {
  echo "$1" >&2
  return 78
}

if [[ ! -f "$MAINA_STORAGE_GUARD" || -L "$MAINA_STORAGE_GUARD" || ! -x "$MAINA_STORAGE_GUARD" ]]; then
  maina_storage_fail "Canonical Maina storage guard is missing or unsafe; refusing fallback." || return $?
fi

guard_mode="$(/usr/bin/stat -f '%Lp' "$MAINA_STORAGE_GUARD" 2>/dev/null)" || {
  maina_storage_fail "Canonical Maina storage guard mode could not be read." || return $?
}
guard_bytes="$(/usr/bin/stat -f '%z' "$MAINA_STORAGE_GUARD" 2>/dev/null)" || {
  maina_storage_fail "Canonical Maina storage guard size could not be read." || return $?
}
guard_sha256="$(/usr/bin/shasum -a 256 "$MAINA_STORAGE_GUARD" | /usr/bin/awk '{print $1}')" || {
  maina_storage_fail "Canonical Maina storage guard hash could not be read." || return $?
}

if [[ "$guard_mode" != "$MAINA_STORAGE_GUARD_MODE" ||
      "$guard_bytes" != "$MAINA_STORAGE_GUARD_BYTES" ||
      "$guard_sha256" != "$MAINA_STORAGE_GUARD_SHA256" ]]; then
  maina_storage_fail "Canonical Maina storage guard identity changed; refusing fallback." || return $?
fi

if storage_root="$("$MAINA_STORAGE_GUARD")"; then
  :
else
  maina_storage_fail "Canonical Maina storage guard rejected this mount; refusing fallback." || return $?
fi
if [[ "$storage_root" != "$MAINA_STORAGE_EXPECTED_ROOT" ]]; then
  maina_storage_fail "Canonical Maina storage guard returned an unexpected root; refusing fallback." || return $?
fi

MAINA_STORAGE_ROOT="$storage_root"
export MAINA_STORAGE_ROOT

# Reject lexical traversal and symlink escapes before a caller creates a path.
maina_require_storage_path() {
  local candidate="${1:-}"
  local probe next resolved
  if [[ -z "$candidate" || "$candidate" != /* || "$candidate" == *$'\n'* ]]; then
    maina_storage_fail "Maina storage path must be one absolute external path."
    return $?
  fi
  case "$candidate" in
    "$MAINA_STORAGE_ROOT"|"$MAINA_STORAGE_ROOT"/*) ;;
    *)
      maina_storage_fail "Maina storage path escapes the guarded external root; refusing fallback."
      return $?
      ;;
  esac
  case "/$candidate/" in
    */../*|*/./*)
      maina_storage_fail "Maina storage path contains traversal; refusing fallback."
      return $?
      ;;
  esac

  probe="$candidate"
  while [[ ! -e "$probe" && ! -L "$probe" ]]; do
    next="${probe%/*}"
    if [[ -z "$next" || "$next" == "$probe" ]]; then
      maina_storage_fail "Maina storage path has no trusted external ancestor."
      return $?
    fi
    probe="$next"
  done
  resolved="$(/bin/realpath "$probe" 2>/dev/null)" || {
    maina_storage_fail "Maina storage path ancestor could not be resolved."
    return $?
  }
  case "$resolved" in
    "$MAINA_STORAGE_ROOT"|"$MAINA_STORAGE_ROOT"/*) ;;
    *)
      maina_storage_fail "Maina storage path resolves outside the guarded volume."
      return $?
      ;;
  esac
}

maina_storage_mkdir() {
  local candidate="${1:?Maina storage directory is required}"
  maina_require_storage_path "$candidate" || return $?
  /bin/mkdir -p "$candidate"
}
