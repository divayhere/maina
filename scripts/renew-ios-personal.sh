#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=maina-ios-env.sh
source "$PROJECT_DIR/scripts/maina-ios-env.sh"
"$PROJECT_DIR/scripts/restore-external-build-links.sh" dependencies

NODE_BIN="$MAINA_IOS_NODE_BIN"
DEVICE_ID="${MAINA_IOS_DEVICE_ID:-945E396B-87B0-5CB7-9A3D-A5E75CF9B4CD}"
DEVICE_UDID="${MAINA_IOS_DEVICE_UDID:-00008120-001E146611E2601E}"
BUNDLE_ID="${MAINA_IOS_BUNDLE_ID:-com.divay.maina.staging}"
TEAM_ID="${MAINA_IOS_TEAM_ID:-9X4X3R4KCN}"
BACKUP_ROOT="${MAINA_MAINTENANCE_ROOT:-$HOME/Library/Application Support/Maina Maintenance}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

export PATH="$NODE_BIN:$PATH"
export NODE_BINARY="$NODE_BIN/node"
export SENTRY_DISABLE_AUTO_UPLOAD="${SENTRY_DISABLE_AUTO_UPLOAD:-true}"
export SENTRY_ALLOW_FAILURE="${SENTRY_ALLOW_FAILURE:-true}"
umask 077

cd "$PROJECT_DIR"
[[ "$(node --version)" == v24.* ]] || { echo "Node 24 is required." >&2; exit 1; }
ACTIVE_CANDIDATE_VERSION="$(node -p "require('./release/m3-m4-0.10.50-candidate-plan.json').release.version")"
if [[ "$(node -p "require('./app.json').expo.version")" == "$ACTIVE_CANDIDATE_VERSION" ]]; then
  echo "Refusing build-and-install renewal for the active candidate. Use the separate candidate build, Admin audit, and provenance-authorized installer." >&2
  exit 2
fi
mkdir -p "$BACKUP_ROOT/Backups" "$BACKUP_ROOT/Crash Reports" "$BACKUP_ROOT/Artifacts"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ROOT="$BACKUP_ROOT/Backups/$RUN_ID"
mkdir -p "$RUN_ROOT/preflight" "$RUN_ROOT/device"

# CoreDevice list metadata can remain disconnected even while a bounded device
# service is usable. Acquire and timestamp that exact service immediately before
# the strict wired-iPhone identity gate; a locked or unavailable phone still
# fails closed here.
CAPABILITY_STARTED_MS="$(node -p 'Date.now()')"
xcrun devicectl device info processes --device "$DEVICE_ID" --timeout 15 --quiet >/dev/null
CAPABILITY_COMPLETED_MS="$(node -p 'Date.now()')"
xcrun devicectl list devices --json-output "$RUN_ROOT/devices.json" --quiet
xcrun devicectl device info apps --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" \
  --columns '*' --json-output "$RUN_ROOT/apps.json" --quiet
node --input-type=module - "$RUN_ROOT/devices.json" "$RUN_ROOT/apps.json" "$DEVICE_ID" "$DEVICE_UDID" "$BUNDLE_ID" "$CAPABILITY_STARTED_MS" "$CAPABILITY_COMPLETED_MS" <<'NODE'
import { readFileSync } from 'node:fs';
import { findInstalledIosApp, findQualifiedIosDevice } from './scripts/lib/renewal-core.mjs';
const [, , devicesPath, appsPath, deviceId, udid, bundleId, startedAtMs, completedAtMs] = process.argv;
const proof = {
  schemaVersion: 'maina.ios-coredevice-capability-proof.v1', deviceId,
  operation: 'device-info-processes', timeoutMs: 15_000,
  startedAtMs: Number(startedAtMs), completedAtMs: Number(completedAtMs), exitCode: 0,
};
findQualifiedIosDevice(JSON.parse(readFileSync(devicesPath)), { deviceId, udid, marketingName: 'iPhone 15', nowMs: Date.now() }, proof);
const app = findInstalledIosApp(JSON.parse(readFileSync(appsPath)), bundleId);
console.log(`Qualified USB iPhone 15; installed Maina ${app.version} (${app.build}).`);
NODE

# Copy before terminating. The durable DB state is the idle gate; an active
# recording/transcription makes renewal fail closed.
xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" --source / --destination "$RUN_ROOT/preflight/container" --quiet
node scripts/inspect-mobile-backup.mjs "$RUN_ROOT/preflight/container" > "$RUN_ROOT/preflight-snapshot.json"
node --input-type=module - "$RUN_ROOT/preflight-snapshot.json" <<'NODE'
import { readFileSync } from 'node:fs';
const snapshot = JSON.parse(readFileSync(process.argv[2]));
if (snapshot.activeRecordings > 0) {
  throw new Error(`Maina is actively recording (${snapshot.activeRecordings}); renewal refused.`);
}
console.log(`Idle gate passed; ${snapshot.meetings} meetings and ${snapshot.transcriptBlocks} transcript blocks are durable.`);
if (snapshot.recoverableProcessingMeetings > 0 || snapshot.activeStages > 0) {
  console.log(`Checkpoint gate passed; ${snapshot.recoverableProcessingMeetings} processing meeting(s) and ${snapshot.activeStages} running stage(s) will resume after the in-place update.`);
}
NODE

if $DRY_RUN; then
  echo "Dry run passed. No process was terminated, no app was built, and nothing was installed."
  exit 0
fi

xcrun devicectl device process terminate --device "$DEVICE_ID" --bundle-id "$BUNDLE_ID" >/dev/null 2>&1 || true
xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" --source / --destination "$RUN_ROOT/device/container" --quiet
xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type systemCrashLogs \
  --source / --destination "$BACKUP_ROOT/Crash Reports/$RUN_ID" --quiet || true
node scripts/inspect-mobile-backup.mjs "$RUN_ROOT/device/container" > "$RUN_ROOT/before.json"

npm run ios:prepare
BUILD_ROOT="${MAINA_IOS_RENEWAL_DERIVED_DATA:-$MAINA_IOS_DERIVED_DATA_ROOT/renewal-$RUN_ID}"
maina_require_storage_path "$BUILD_ROOT" || exit $?
[[ ! -e "$BUILD_ROOT" ]] || {
  echo "iOS renewal DerivedData already exists; refusing mixed build state." >&2
  exit 73
}
xcodebuild -workspace ios/Maina.xcworkspace -scheme Maina -configuration Release \
  -destination "platform=iOS,id=$DEVICE_UDID" -derivedDataPath "$BUILD_ROOT" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  PODFILE_DIR="$PROJECT_DIR/ios" build
APP="$BUILD_ROOT/Build/Products/Release-iphoneos/Maina.app"
codesign --verify --deep --strict "$APP"

PROFILE_PLIST="$RUN_ROOT/profile.plist"
ENTITLEMENTS_PLIST="$RUN_ROOT/entitlements.plist"
security cms -D -i "$APP/embedded.mobileprovision" > "$PROFILE_PLIST"
codesign -d --entitlements :- "$APP" > "$ENTITLEMENTS_PLIST" 2>/dev/null
node --input-type=module - "$APP/Info.plist" "$PROFILE_PLIST" "$ENTITLEMENTS_PLIST" "$BUNDLE_ID" "$TEAM_ID" <<'NODE'
import { execFileSync } from 'node:child_process';
import { validateCandidateIdentity } from './scripts/lib/renewal-core.mjs';
const [, , info, profile, entitlements, bundleId, teamId] = process.argv;
const pl = (path, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path], { encoding: 'utf8' }).trim();
const profileExpiry = execFileSync('/usr/bin/plutil', ['-extract', 'ExpirationDate', 'raw', profile], {
  encoding: 'utf8',
}).trim();
let groups = '';
try {
  groups = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :keychain-access-groups', entitlements], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {
  // No explicit group means the default application-identifier group; the
  // identity check below still pins the same Team ID and bundle identifier.
}
validateCandidateIdentity({
  bundleId: pl(info, 'CFBundleIdentifier'),
  teamId: pl(entitlements, 'com.apple.developer.team-identifier'),
  applicationIdentifier: pl(entitlements, 'application-identifier'),
  keychainGroups: groups.split(/\s+/).filter((x) => x.includes('.')),
  profileExpiresAt: new Date(profileExpiry),
}, { bundleId, teamId, minimumExpiryMs: Date.now() + 2 * 86_400_000 });
console.log('Candidate signing identity, Keychain group, and profile expiry verified.');
NODE

cp -R "$APP" "$BACKUP_ROOT/Artifacts/Maina-$RUN_ID.app"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID"
sleep 5
xcrun devicectl device copy from --device "$DEVICE_ID" --domain-type appDataContainer \
  --domain-identifier "$BUNDLE_ID" --source / --destination "$RUN_ROOT/postflight-container" --quiet
node scripts/inspect-mobile-backup.mjs "$RUN_ROOT/postflight-container" > "$RUN_ROOT/after.json"
node scripts/validate-renewal-snapshots.mjs "$RUN_ROOT/before.json" "$RUN_ROOT/after.json"
echo "Personal-signing renewal succeeded in place. Backup: $RUN_ROOT"
