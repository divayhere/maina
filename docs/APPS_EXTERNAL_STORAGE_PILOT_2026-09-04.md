# Apps external-storage pilot result — 2026-09-04

Status: the Android representative no-device pilot passed. iOS storage routing and the non-compiling Xcode settings probe passed; an iOS compiler/signing pilot was not attempted because no current provisioning profile was available.

## Bound control plane

- Canonical layout: `/Users/divay/Developer/Maina/qualification/storage-architecture/MAINA_STORAGE_LAYOUT.md`, SHA-256 `6f9e200c380b8230be2b5b0cfe13d08852f6de8010aaf7cf6f2ab6989dc9826c`, 2,960 bytes, mode `0644`.
- Canonical guard: `/Users/divay/Developer/Maina/qualification/storage-architecture/jobs/storage-local-staging-format-20260904/require-maina-storage.sh`, SHA-256 `e8efcaa346ca46ed746970f7739f1346f25442719961f1c8e3d884b3d54c538f`, 3,387 bytes, mode `0755`.
- Guard success was exit `0` with exact root `/Volumes/DivaySSD/MainaBuild`. The bound wrappers reject absent, wrong, or unsafe storage with exit `78` and no internal fallback.
- Audited source baselines: Android/shared `c3fb09043be9e71121a80f6640f05db76396b446`; iOS `efde3ce18a54d1f61660d485f475a41b6f3b086c`. Both were clean and upstream-exact before the pilot.

## Android pilot

1. Guarded generated-native preparation: `npm run android:prepare`; exit `0`; elapsed `4 s`.
2. Guarded Gradle invocation after sourcing `scripts/maina-build-env.sh` and restoring Android links: `"$MAINA_GRADLE_HOME/bin/gradle" --gradle-user-home "$MAINA_GRADLE_USER_HOME" --project-cache-dir "$MAINA_GRADLE_PROJECT_CACHE" :maina-recorder:testDebugUnitTest :app:compileDebugKotlin`; exit `0`; elapsed `65 s`; 259 tasks reported.
3. The exact unit-test scope produced 90 tests with 0 failures, 0 errors, and 0 skipped. `:app:compileDebugKotlin` completed; no APK/release build or device action was requested.
4. Generated/native and module outputs resolved to:
   - `/Volumes/DivaySSD/MainaBuild/builds/apps/android-main/android/native/root`
   - `/Volumes/DivaySSD/MainaBuild/builds/apps/android-main/android/native/app`
   - `/Volumes/DivaySSD/MainaBuild/builds/apps/android-main/android/outputs/_app`
   - `/Volumes/DivaySSD/MainaBuild/builds/apps/android-main/android/outputs/_maina-recorder`
5. `/Users/divay/.cache/maina-build-v2` and `/Users/divay/.cache/maina-build-v2/outputs` remained real internal directories on device `16777230`. The protected `outputs` tree stayed at 1,258,696 KiB and its pre/post directory mtime remained `1788214462`; the external pilot did not update it. Only the approved `gradle-user-home` and `gradle-project-cache` children, plus `/Users/divay/.cache/maina-gradle-project`, resolve to the SSD.

## iOS readiness and generated-output handoff

1. Guarded control-plane probe: `PATH="$PWD/scripts/external-bin:$PATH" scripts/external-bin/xcodebuild -workspace ios/Maina.xcworkspace -scheme Maina -configuration Release -showBuildSettings`; exit `0`; latest elapsed `3 s`. The project/workspace call was routed through the external DerivedData shim. Bare shim passthrough remains limited to non-building controls such as `-version` and `-checkFirstLaunchStatus`.
2. No compiler/signing pilot was run. The exact Team certificate/toolchain gate was available, but there was no current matching provisioning profile; profile refresh and a signed build remain separate work.
3. The ignored real `ios/build` tree was proven to contain only reproducible generated Expo/React Native metadata, then preserve-copied and re-read before cutover: 90 regular files, 21 directories including root, 0 symlinks, 465,763 logical bytes, 700 KiB allocated.
4. Normalized source/copy evidence matched exactly:
   - file manifest SHA-256 `8032fdc12c0b2bb24178ad045fb392d126412998e3cc6c0a7c5d297bfea685bc`
   - directory manifest SHA-256 `060bc8f89aca27cba64ceed705c800df8426789faac7164e0f42f03f66a48a25`
   - extended-attribute manifest SHA-256 `1d40907f948b2fe3508a3ae2730a5b6f2f997a9e5fb4274e99a650fbba4a5f45` across 111 source and 111 copy nodes
5. `/Users/divay/Developer/.worktrees/maina-ios-feasibility/ios/build` is now the exact absolute symlink to `/Volumes/DivaySSD/MainaBuild/builds/apps/ios-feasibility/ios/native`. `lstat`, `readlink`, `realpath`, normalized manifests, and followed device identity all passed. The internal original was retained until those checks and the focused verifier passed, then only that temporary rollback copy was removed.

## Safety boundary

No signed release build, install, device mutation, credential/signing change, product feature change, or release/qualification evidence move occurred. Source and common Git history, credentials, unique signed artifacts, qualification evidence, and device data remain internal. The SSD is required only for guarded dependency/build/output work; without it, source remains inspectable/editable/committable, while build entrypoints stop with exit `78`.
