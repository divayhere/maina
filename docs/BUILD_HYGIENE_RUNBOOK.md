# Maina Android build hygiene runbook

## Coordination gate

This checkout consumes the private `maina-coordination` repository as the
`coordination` Git submodule. Initialise it after cloning, before any release
verification:

```bash
git submodule update --init --recursive
npm run verify:coordination
```

Before changing an integration-affecting app path, add a sanitized central
state/workplan update first, advance the `coordination` pointer in the same app
change, and let CI run its policy change gate. Never put credentials or
meeting/transcript content in the coordination repository.

## Canonical local workspace

Use `/Users/divay/Developer/MainaV2` for active app work. Do not build from a
Desktop, cloud-synced, copied, or duplicate source tree.

## Required commands

```bash
npm ci
npm run verify:toolchain
npm run verify:release
```

The bootstrap script deliberately does not force `NODE_ENV=production` before
`npm ci`: Maina's reproducible install needs the checked-in dev dependency
`patch-package` during `postinstall`. Release commands set their own runtime
mode only after dependencies are present.

`verify:release` is the release gate. It runs static checks, Expo dependency
compatibility, Android regeneration, configuration parity validation, Android
module unit tests, Kotlin compilation, and merged-manifest assertions. It does
not produce an APK.

## Toolchain contract

The scripts source `scripts/maina-env.sh`, which requires:

- Node 24
- JDK 17
- Android SDK platform-tools
- the wired Pixel serial configured in `MAINA_ADB_SERIAL`
- external Gradle cache/output directories configured by `MAINA_BUILD_ROOT`

Use `scripts/adb-usb.sh` rather than bare `adb` so a Wi-Fi ADB identity cannot
accidentally be selected.

## Native generation contract

`android/` is generated and intentionally ignored. Never hand-edit it as the
source of truth. Run `npm run android:prepare` before a native build; it runs
Expo prebuild and confirms Android package, version name, and version code
match `app.json`.

The native Maina module under `modules/maina-recorder/` is tracked source and
is the source of truth for foreground recording, post-processing, hardware
control, and ASR integration.

## Release hygiene rules

- Never copy app source or `node_modules` in Finder. Use Git and `npm ci`.
- Never use `npm audit fix --force` as a release repair mechanism.
- Do not build an APK until `npm run verify:release` passes.
- Keep signing files ignored and local. Never add credentials, tokens, or
  recordings to Git.
- A generated APK is a release artifact, not a source dependency.

## Knowledge Cloud boundary

This hygiene change does not alter Maina Knowledge Cloud endpoints, payload
schemas, token names, source keys, or sync semantics. Before any future change
that affects those, update the shared MKC integration registry and workstate
from an environment that can access the backend repository.
