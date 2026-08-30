# Android/iOS shared-source convergence inventory

Date: 2026-08-30

This inventory was completed before any shared source was copied into the iOS
worktree.

## Pins and preservation

- Common ancestor: `92b324aee240d574dc46c080dc1cb8eb39d6ddf7`
- Android release base: `47d5a86a92792bbe046bc7cbd5f73b3654724d4e`
- iOS release base: `8c08fcca25b5e7ea4fa3230a2cb40d3878535ef7`
- Preserved pre-convergence WIP: `920bf4297168c849af8a37a065182b5982f2ee59`
- Frozen Backend input: `6b2bcf43c2e8c4fb7c40a6cb6fb49e643099f93b`
- Frozen Web input: `5b11bb026ff5fff36c7b393add9c0c64986a1335`

The preservation checkpoint contains no detected API key, password, bearer
token, private key, signing material, raw transcript, or customer fixture.

## Three-way result

The branches contain three distinct classes. No file in the first two classes
may be replaced blindly.

### iOS-only shared behavior to preserve and integrate

| File | Required disposition |
| --- | --- |
| `src/app/(tabs)/diagnostics.tsx` | Preserve iOS diagnostics behavior; merge only shared copy/security changes. |
| `src/app/(tabs)/help.tsx` | Preserve iOS help/device wording. |
| `src/app/(tabs)/meeting/[id].tsx` | Preserve iOS terminal/progress behavior while moving the canonical detail route outside tabs. |
| `src/app/(tabs)/meeting/[id]/recover.tsx` | Preserve iOS recovery behavior while moving the route outside tabs. |
| `src/core/recording/nativeCaptureReconciliation.ts` | Canonicalize; this is required iOS capture truth and is safe for Android behind platform/native evidence. |
| `src/core/recording/nativeCaptureReconciliation.test.ts` | Canonicalize with the implementation. |
| `src/design/components.tsx` | Preserve platform-neutral visual fixes. |
| `src/hardware/recording/nativeCaptureLifecycle.ts` | Canonicalize the platform-aware lifecycle adapter. |
| `src/services/audioRetentionCore.ts` | Canonicalize verified cleanup rules. |
| `src/services/audioRetentionCore.test.ts` | Canonicalize cleanup tests. |
| `src/services/iosAsrRecoveryPolicy.ts` | Preserve as an iOS-scoped module in both source trees. |
| `src/services/iosAsrRecoveryPolicy.test.ts` | Preserve with its iOS-scoped module. |
| `src/services/localAsrCheckpointCore.ts` | Canonicalize the platform-neutral checkpoint policy. |
| `src/services/localAsrCheckpointCore.test.ts` | Canonicalize checkpoint tests. |
| `src/services/localAsrPipeline.ts` | Merge; retain iOS checkpoint/recovery paths and Android Qwen behavior. |

### Preserved WIP-only shared additions

| File | Required disposition |
| --- | --- |
| `index.js` | Keep only if the public Headless JS registration boundary passes static and later physical proof. |
| `src/app/(tabs)/notifications.tsx` | Merge local refresh and convergence behavior. |
| `src/app/(tabs)/todos.tsx` | Merge local refresh and origin-aware meeting navigation. |
| `src/app/meeting/[id].tsx` | Canonical outer meeting detail route. |
| `src/app/meeting/[id]/recover.tsx` | Canonical outer recovery route. |
| `src/app/meeting/_layout.tsx` | Canonical focused detail stack. |
| `src/core/navigation/navigationPolicy.ts` | Canonical history policy. |
| `src/core/navigation/navigationPolicy.test.ts` | Canonical policy tests; add real-router coverage. |
| `src/core/pipeline/cloudFailure.ts` | Rewrite to structured classification without message parsing. |
| `src/core/pipeline/cloudFailure.test.ts` | Expand typed/safe-copy matrix. |
| `src/core/pipeline/pipelineWakeState.ts` | Replace draft reducer with durable generation/lease semantics. |
| `src/core/pipeline/pipelineWakeState.test.ts` | Replace draft tests with behavioral crash-window coverage. |
| `src/data/pipelineWake.ts` | Consolidate into migration 16 and one SQLite scheduling authority. |
| `src/hardware/pipelineWake.ts` | Keep a scheduling-only native bridge. |
| `src/headless/pipelineWakeTask.ts` | Service already-durable generations only. |
| `src/headless/pipelineWakeTask.test.ts` | Prove obsolete/no-work Workers are true no-ops. |
| `src/headless/registerPipelineWake.ts` | Register public Headless JS task once. |
| `src/services/audioRetention.ts` | Merge event-driven cleanup with iOS core rules. |
| `src/services/pipelineWakeScheduler.ts` | Rewrite around observed enqueue outcomes and bounded repair. |
| `src/services/pipelineWakeScheduler.test.ts` | Add behavioral scheduler/repair tests. |

### Divergent overlapping files requiring a deliberate merge

The following paths have different blobs in the preserved WIP and iOS base.
They are all canonical parity targets after platform-aware reconciliation:

- `modules/maina-recorder/src/index.ts`
- `package.json`
- `src/app/(tabs)/_layout.tsx`
- `src/app/(tabs)/index.tsx`
- `src/app/(tabs)/settings.tsx`
- `src/app/_layout.tsx`
- `src/app/record.tsx`
- `src/core/recording/appFileReference.ts`
- `src/core/recording/appFileReference.test.ts`
- `src/core/recording/audioLevel.ts`
- `src/core/recording/audioLevel.test.ts`
- `src/data/db.ts`
- `src/data/meetings.ts`
- `src/design/shell.tsx`
- `src/hardware/recording/foreground.ts`
- `src/services/backgroundPipeline.ts`
- `src/services/backgroundPipelineCore.ts`
- `src/services/backgroundPipelineCore.test.ts`
- `src/services/mainaCloudSession.ts`
- `src/services/mainaCloudSession.test.ts`
- `src/services/mainaKnowledgeCloud.ts`
- `src/services/mainaKnowledgeCloud.test.ts`
- `src/services/mainaKnowledgeCloudCore.ts`
- `src/services/meetingCaptureLifecycle.ts`
- `src/services/meetingPacket.ts`
- `src/services/meetingPacket.test.ts`
- `src/services/meetingPresentation.ts`
- `src/services/meetingPresentation.test.ts`
- `src/services/notifications.ts`
- `src/services/notifications.test.ts`
- `src/services/transcriptCoverage.ts`
- `src/services/transcriptCoverage.test.ts`

For every path above, the final file is authored once on the Android canonical
branch, transferred mechanically to iOS, and hash-compared. There will be no
second manual iOS edit.

## Explicit parity allowlist

Intentional platform differences are outside the shared parity manifest:

- `modules/maina-recorder/android/**`
- `modules/maina-recorder/ios/**`
- generated `android/**` and `ios/**`
- Android and iOS config plugins that only declare native services,
  capabilities, permitted task identifiers, or build settings
- `app.json` version/build and signing-target values
- platform build/install/renewal scripts
- `ios-tests/MainaUITests.swift`
- `scripts/stop-dual-device-soak.sh`
- platform qualification evidence, local artifacts, and documentation

No business contract, SQLite schema, cloud retry rule, route policy, or
presentation truth is allowlisted. Those must have byte-identical shared source
and tests after convergence.

## Verification

The final parity verifier compares tracked blob hashes for the declared shared
manifest. Any mismatch not covered by the allowlist fails the pre-artifact
gate. Native platform files are reviewed separately and are never used as a
reason to duplicate the cloud packet, retry outbox, source contract, or local
database.

## Final pre-transfer inventory

This second inventory was run after the canonical shared implementation was
split into `811d9e2` and the iOS-preservation correction `0368677`, but before
either commit was applied to the iOS worktree. It compares every canonical
shared path against both the common ancestor and iOS `8c08fcc`.

Twenty-nine canonical paths had no iOS delta from the common ancestor. They
are new recovery, navigation, typed-failure, claim-fence, cleanup, and test
files and can be transferred mechanically.

The following 14 paths had independent iOS history and were reviewed
individually before transfer:

| Shared path | iOS behavior identified | Canonical disposition |
| --- | --- | --- |
| `modules/maina-recorder/src/index.ts` | Async status, iOS automation, continued processing, storage diagnostics. | Preserved; Android wake methods added without removing iOS fields. |
| `package.json` | iOS runtime/model/UI-test/renewal verification scripts. | Preserved; shared Headless entry added and all iOS scripts retained. |
| `src/app/(tabs)/index.tsx` | Markdown-to-readable summary preview. | Preserved together with event-driven pipeline refresh. |
| `src/app/_layout.tsx` | Async iOS capture reads and qualification launch scenarios. | Preserved; Android-only remote/language setup remains platform-gated. |
| `src/app/record.tsx` | Native iOS microphone permission, async capture reads, qualification scenarios, and foreground ASR launch. | Preserved; truthful pause/timer/navigation behavior layered on top. |
| `src/data/db.ts` | Existing v13 iOS per-window checkpoint schema. | Preserved; consolidated unshipped v16 is additive and no v17 remains. |
| `src/data/meetings.ts` | Portable iOS audio references and per-window checkpoints. | Preserved; generation fencing added. Explicit re-transcription clears only derived ASR claims/windows, never audio. |
| `src/services/backgroundPipelineCore.ts` | Ordered cross-platform recovery stages. | Preserved; ownership checkpoints and signal coalescing added. |
| `src/services/backgroundPipelineCore.test.ts` | Recovery-order and failure tests. | Preserved and expanded. |
| `src/services/mainaCloudSession.ts` | Platform-neutral pairing and deployed `user.id` exchange shape. | Preserved; pairing transport errors are typed and hostname-safe. |
| `src/services/mainaCloudSession.test.ts` | Pairing exchange compatibility. | Preserved and expanded with neutral-label and privacy tests. |
| `src/services/mainaKnowledgeCloud.test.ts` | Awaited source drain and terminal signal proof. | Preserved; typed retry arming remains additive. |
| `src/services/meetingCaptureLifecycle.ts` | iOS local-Qwen owner, continued processing, retries, and cloud handoff. | Preserved; foreground and OS callers now share one awaitable keyed completion. |
| `src/services/notifications.ts` | Existing notification projection. | Temporary transport failures now use safe self-healing copy; partial transcript remains visible on the meeting instead of creating a redundant alert. |

Transfer rule: apply the two shared commits once to iOS, resolve no file by
copying from memory, and compare final tracked blob hashes. Any post-transfer
shared mismatch not covered by the explicit native/harness allowlist is a hard
failure.
