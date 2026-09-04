# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Storage Contract (mandatory)

For all Apps dependency, Expo prebuild/native-run, Gradle/Xcode build, UI-test configuration, and release-output work, follow the Git-backed canonical policy at `coordination/docs/storage/MAINA_STORAGE_LAYOUT.md` (maina-coordination destination `docs/storage/MAINA_STORAGE_LAYOUT.md`; SHA-256 `87b7cf7f677ee6440013656dc1b2c85c8f99df863c5ea764f17a8eb687277bba`; 29,047 bytes; mode `0644`). `/Users/divay/Developer/Maina/qualification/storage-architecture/MAINA_STORAGE_LAYOUT.md` is the installed operational mirror, not the Git source of truth. Use only the repository's guarded package/release entrypoints—such as `npm run android:prepare`, `npm run android`, `npm run android:build-candidate`, `npm run verify:release`, and, from the canonical iOS worktree, `npm run ios:prepare`, `npm run ios`, `npm run ios:renew-personal`, `npm run ios:build-candidate`, and `npm run ios:ui-tests:configure`—or an established guarded release script. Never invoke Expo prebuild/native-run, Gradle, or Xcode project/workspace build commands directly; if no guarded entrypoint exists, stop. The Xcode shim's bare passthrough is only for non-building control-plane commands such as `-version` or `-checkFirstLaunchStatus`.

Those entrypoints must bind the canonical guard published at `coordination/scripts/storage/require-maina-storage.sh` and installed at `/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh` (SHA-256 `e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f`; 3,387 bytes; mode `0755`); reference it rather than copying or reimplementing it. An absent, wrong, or unsafe SSD—or changed/rejected guard—must exit 78 before output creation, with no internal fallback. After `expo prebuild --clean`, restore dependency/native links only through the guarded repository wrapper.

Keep source, `.git`, coordination/control data, credentials/signing material, unique release artifacts, qualification evidence, and device data internal. `/Users/divay/.cache/maina-build-v2` and `/Users/divay/.cache/maina-build-v2/outputs` must remain real internal directories. Only its `gradle-user-home` and `gradle-project-cache` children, plus `/Users/divay/.cache/maina-gradle-project`, are approved fail-closed links to `/Volumes/DivaySSD/MainaBuild`; never redirect the protected parent or `outputs`.

A future real-directory cutover is not accepted unless its sanitized source/copy manifest receipt is retained outside both trees and hash-bound in tracked pilot evidence before the rollback is removed. The receipt must record relative-path, mode, byte, and content hashes; applicable directory and extended-attribute summaries; policy and guard identities; timestamps; and the verification result. Never reconstruct a missing receipt after cutover.

## Shared Maina workstate

Before every work cycle, read `/Users/divay/Documents/ChatGPT/maina/.codex/WORKSTATE.md`.

Update that file after every meaningful app change, build, test, install, blocker, fix attempt, real-device check, or handoff. Add activity entries newest first and preserve existing history. Never write secrets, API keys, bearer tokens, private credentials, or raw customer content there.

Treat `/Users/divay/Documents/ChatGPT/maina/docs/MAINA_ANDROID_PRODUCTION_BASELINE_2026-08-21.md` as a stable reference snapshot, not a rolling log. Do not commit or overwrite work owned by another active task.
