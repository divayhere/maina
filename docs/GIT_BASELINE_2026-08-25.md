# MainaV2 clean Git baseline — 25 August 2026

This repository is a clean, independent Git baseline created from the
already-qualified Maina worktree. It replaces a Desktop-hosted worktree whose
Git object store and filesystem state had become unreliable for local Android
builds.

## Provenance

- Application checkpoint: `3ec7f9d406c3ce8109fcb8b396514d952a129512`
- Build-harness checkpoint: `2c78a14f05f22f04fa99ab37d51f17f24bff8b96`
- Source was copied without generated Android/iOS directories, dependencies,
  build outputs, caches, or Git metadata.
- Private signing material was carried locally only and remains ignored by Git.

## Why this baseline exists

The former Desktop checkout accumulated duplicate source files, invalid loose
Git refs, incomplete copied dependency trees, and cloud-synced filesystem
behavior that could stall Git, TypeScript, Gradle, and CMake. The deterministic
release harness in `docs/BUILD_HYGIENE_RUNBOOK.md` is retained here and is the
only supported local Android build path.

## Scope

This is a repository/build-hygiene reset only. It does not alter Maina capture,
ASR, Maina Knowledge Cloud URLs/endpoints/payload contracts, sync semantics, or
any backend/web deployment.
