#!/usr/bin/env bash
set -euo pipefail

GRADLE_VERSION="9.3.1"
EXPECTED_SHA256="b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06"
TOOLS_ROOT="${MAINA_GRADLE_TOOLS_ROOT:-/Users/divay/.cache/maina-build-tools/gradle}"
ARCHIVE="$TOOLS_ROOT/gradle-$GRADLE_VERSION-bin.zip"
GRADLE_HOME="$TOOLS_ROOT/gradle-$GRADLE_VERSION"
export JAVA_HOME="${MAINA_JAVA_HOME:-/Users/divay/.cache/maina-build-tools/jdk17/Contents/Home}"

mkdir -p "$TOOLS_ROOT"
if [[ ! -x "$GRADLE_HOME/bin/gradle" ]]; then
  current_sha="$(shasum -a 256 "$ARCHIVE" 2>/dev/null | awk '{print $1}' || true)"
  if [[ "$current_sha" != "$EXPECTED_SHA256" ]]; then
    curl --fail --location --retry 5 --retry-all-errors --connect-timeout 30 \
      --output "$ARCHIVE" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  fi
  actual_sha="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [[ "$actual_sha" == "$EXPECTED_SHA256" ]] || {
    echo "Gradle archive checksum mismatch: $actual_sha" >&2
    exit 1
  }
  unzip -q -o "$ARCHIVE" -d "$TOOLS_ROOT"
fi
[[ "$($GRADLE_HOME/bin/gradle --version | sed -n 's/^Gradle //p')" == "$GRADLE_VERSION" ]] || {
  echo "Pinned Gradle $GRADLE_VERSION is unavailable." >&2
  exit 1
}
echo "Pinned Gradle $GRADLE_VERSION is ready."
