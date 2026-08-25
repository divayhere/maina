#!/usr/bin/env bash
# Source this file before any local Android command. Values can be overridden
# for another machine without changing the repository.

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "Maina build scripts require Bash; do not source scripts/maina-env.sh from zsh." >&2
  return 2
fi

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source this file: source scripts/maina-env.sh" >&2
  exit 2
fi

MAINA_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAINA_NODE_BIN="${MAINA_NODE_BIN:-/Users/divay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin}"
MAINA_JAVA_HOME="${MAINA_JAVA_HOME:-/Users/divay/.cache/maina-build-tools/jdk17/Contents/Home}"
MAINA_ANDROID_HOME="${MAINA_ANDROID_HOME:-/Users/divay/Library/Android/sdk}"
MAINA_BUILD_ROOT="${MAINA_BUILD_ROOT:-/Users/divay/.cache/maina-build-v2}"
MAINA_ADB_SERIAL="${MAINA_ADB_SERIAL:-47011FDAP000VE}"
MAINA_ANDROID_ABI="${MAINA_ANDROID_ABI:-arm64-v8a}"

if [[ ! -x "$MAINA_NODE_BIN/node" ]]; then
  echo "Maina requires Node 24. Set MAINA_NODE_BIN to its bin directory." >&2
  return 2
fi
if [[ ! -x "$MAINA_JAVA_HOME/bin/java" ]]; then
  echo "Maina requires JDK 17. Set MAINA_JAVA_HOME to the JDK home." >&2
  return 2
fi
if [[ ! -x "$MAINA_ANDROID_HOME/platform-tools/adb" ]]; then
  echo "Maina requires Android SDK platform-tools. Set MAINA_ANDROID_HOME." >&2
  return 2
fi

export PATH="$MAINA_NODE_BIN:$PATH"
export JAVA_HOME="$MAINA_JAVA_HOME"
export ANDROID_HOME="$MAINA_ANDROID_HOME"
export ANDROID_SDK_ROOT="$MAINA_ANDROID_HOME"
export GRADLE_USER_HOME="$MAINA_BUILD_ROOT/gradle-user-home"
export NODE_ENV=production
export MAINA_REPO_ROOT MAINA_NODE_BIN MAINA_JAVA_HOME MAINA_ANDROID_HOME
export MAINA_BUILD_ROOT MAINA_ADB_SERIAL MAINA_ANDROID_ABI

mkdir -p "$MAINA_BUILD_ROOT/gradle-project-cache" "$MAINA_BUILD_ROOT/outputs"
