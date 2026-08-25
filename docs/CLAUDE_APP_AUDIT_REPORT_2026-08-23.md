# Claude Audit Report — Maina Android Application

**Date:** 2026-08-23 · **Auditor:** Claude (independent second opinion)
**Scope:** Maina Android/Expo app at `/Users/divay/Desktop/Software/Maina` — source, native module, build artifacts, APK, tests, and the app↔MKC sync interface.
**Companion report:** `CLAUDE_AUDIT_REPORT_2026-08-23.md` (MKC backend + hosted web) in `/Users/divay/Documents/ChatGPT/maina/docs/`.
**Method:** repo/build-state analysis → APK binary inspection (`aapt2`) → source audit of sync + storage → attempted quality-gate execution.

---

## Executive summary

The app's **engineering quality is high** — 18 test files, correct Android permissions, a hardened release APK, and a native recorder module whose recent changes show genuinely sophisticated reasoning about SQLite ownership and crash-safety. The MKC sync integration correctly implements the frozen contract I verified against the live backend.

**But the app is currently in an unshippable, unverifiable state**, for three converging reasons:

| # | Finding | Severity |
|---|---|---|
| 1 | Native recorder surgery is **mid-flight and partly untracked** in git | 🔴 CRITICAL |
| 2 | `tsc --noEmit` **blocks at 0% CPU indefinitely** (reproduced, 8+ min) — typecheck/lint gate unrunnable | 🟠 HIGH |
| 3 | Source is **v0.10.13 / versionCode 39 with no APK ever built** (newest is 0.10.12 / 38) | 🟠 HIGH |

**Important positive correction:** the **test suite runs and fully passes — 18 files / 79 tests in 10.47s**, on the current (uncommitted) tree. My initial read that "the quality gate cannot run" was too broad: **`vitest` is fine; only `tsc` blocks.** The TypeScript layer of the in-flight native change therefore *does* have passing test evidence. The Kotlin side does not.

Net: uncommitted native changes that are **tested at the TS layer, but never compiled, never type-checked, and never built into an APK.** Commit them and build 0.10.13 before shipping.

---

## 1. Findings

### 🟠 HIGH-1 — `tsc --noEmit` blocks at 0% CPU (typecheck/lint gate unrunnable)
**Independently reproduced with hard evidence.**

> **Scope correction (verified after first draft):** this affects **`tsc` only**. `npx vitest run` completes in **10.47s with 18/18 files and 79/79 tests passing**. The distinction matters and is diagnostic: `vitest` (esbuild) transpiles only the modules actually imported and never type-checks, whereas `tsc` walks the entire type graph including every `@types` package across 577 `node_modules` entries — which is what triggers the File Provider materialization storm. **Downgraded CRITICAL → HIGH**: the repo is testable, just not type-checkable.

```
PID    %CPU  %MEM  ELAPSED  STAT  COMMAND
96677   0.0   0.4    08:08    S    node .../tsc --noEmit
```
`STAT=S` (sleeping/blocked), **0.0% CPU after 8 minutes**, zero output. The process is not computing — it is blocked on I/O. `git diff --stat` on the same repo also timed out at 2 minutes.

**Root cause: the app repo lives in a cloud-synced folder.** `/Users/divay/Documents` reports `replicated KF: **desktop,documents**` — Desktop & Documents Folder Syncing is enabled, and **`~/Desktop/Software/Maina` is inside the synced Desktop tree**. The File Provider must materialize dataless files on demand; with 577 `node_modules` packages, `tsc` stalls.

**This is not a new discovery — it is your own documented bug, now proven.** `WORKSTATE.md` records: *"an attempted repeat TypeScript check stalled at zero CPU in the Desktop/File Provider workspace and was stopped cleanly. The app source is unchanged from the already-qualified checkpoint; this is not recorded as a code failure."*

That judgement was correct and honest. But the consequence deserves to be stated plainly: **`npm run check` (typecheck → test → lint → expo-doctor) cannot complete on this machine**, so no change to the app can currently be verified before shipping.

**Cross-cutting note:** the MKC backend repo (`~/Documents/ChatGPT/maina`) is in the *same* synced tree, where it produced a conflict copy (`src/intake/service 2.ts`) that broke that repo's typecheck. **One environmental cause is now degrading both projects.**

**Fix (highest leverage action available):** move both repos out of the synced tree (e.g. `~/dev/maina`, `~/dev/mkc`), or disable Desktop & Documents syncing. Everything else in both reports is downstream of this.

---

### 🔴 CRITICAL-2 — Native recorder surgery is mid-flight, and partly untracked
**Verified via git status + file inspection.**

The working tree has uncommitted changes across the **native Android recorder module** and the TS layer that drives it:

```
 D modules/.../MainaAppDatabase.kt            ← DELETED
 M modules/.../MainaPostProcessingService.kt
 M modules/.../MainaRecorderModule.kt
 M modules/.../MainaRecordingService.kt
 M modules/maina-recorder/src/index.ts
 M src/data/db.ts · src/data/meetings.ts
 M src/services/meetingCaptureLifecycle.ts
 M src/hardware/recording/foreground.ts
 M src/app/record.tsx · src/app/(tabs)/index.tsx · .../meeting/[id].tsx
 M app.json · package.json
?? modules/.../MainaPostProcessingOutbox.kt   ← NEW, UNTRACKED (257 lines)
?? metro.config.js                            ← NEW, UNTRACKED
```

**The work itself looks excellent.** The new `MainaPostProcessingOutbox.kt` carries a rationale comment that demonstrates real understanding of the failure it prevents:

> *"Durable hand-off between the service-owned ASR process and the Expo runtime. This intentionally never touches `maina.db`: Expo SQLite owns that database. The foreground JS runtime reads a completed native run and imports it in one transaction, which keeps a process restart from producing a half-written UI transcript or a cross-driver SQLite crash."*

That directly addresses the bugs visible in recent history (`fix: configure native SQLite connections safely`, `fix: open Expo SQLite database from native post-processing`). This is the right architectural fix — replacing a shared-database coupling with a single-writer outbox.

**The risk is purely one of state, not design:**
1. A **database class was deleted** and a **replacement outbox added** — a schema/ownership change spanning Kotlin + TS — with **none of it committed**.
2. `MainaPostProcessingOutbox.kt` is **untracked**, so it exists only in the working tree. A `git checkout`/`stash`/clean would delete 257 lines of new native code permanently.
3. This sits in the **cloud-synced folder** that has already produced a conflict copy in the sibling repo (CRITICAL-1).
4. It has **never been compiled or tested** (CRITICAL-1 blocks the gate; no 0.10.13 APK exists).

**Fix:** commit this work now, on a branch, before anything else. Even a WIP commit converts an unrecoverable state into a recoverable one.

---

### 🟠 HIGH-3 — Version bumped to 0.10.13 with no build; branch name is stale
**Verified via `aapt2` on the shipped binary.**

| | Source (`app.json`) | Newest APK (`dist/`) |
|---|---|---|
| versionName | **0.10.13** | 0.10.12 |
| versionCode | **39** | 38 |

`aapt2 dump badging` confirms the newest artifact is `versionCode='38' versionName='0.10.12'`. The local Gradle output at `android/app/build/outputs/apk/release/app-release.apk` is **older still** (dated Aug 22 17:11, byte-identical in size to the 0.10.8 build).

So **0.10.13 / 39 exists only as an unbuilt version bump** wrapping the uncommitted native surgery of CRITICAL-2. There is no artifact to test, and no evidence the current tree compiles.

**Also:** the working branch is `codex/ui-v2-integration`, but the last 8 commits are recording-reliability and SQLite fixes (`harden local recording reliability`, `keep native recording duration authoritative`, `configure native SQLite connections safely`…). The branch name no longer describes its contents — minor, but it misleads anyone reading history to reconstruct what shipped.

---

### 🟡 MEDIUM-4 — MKC token and LLM API keys are stored unencrypted
**Verified via source + dependency inspection.**

Settings are persisted as plain key/value rows in app-private SQLite (`src/data/db.ts:49-53`):
```sql
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY NOT NULL, value TEXT );
```
This table holds the **MKC bearer token** and the **user's third-party LLM API keys** (Gemini/OpenAI/Anthropic/Grok/DeepSeek). Confirmed: **`expo-secure-store` is not installed**, no `SecureStore`/Keystore usage anywhere, and no encryption/SQLCipher in the data layer.

**Credit — the mitigations that matter are already in place:**
- `allowBackup: false` in **both** `app.json:17` and the generated `AndroidManifest.xml` — blocks the main extraction path (ADB/cloud backup).
- Release APK is **not debuggable** (verified via `aapt2`).
- Android's app sandbox protects app-private storage on a non-rooted device.

**Assessment:** for a single-user, privately-sideloaded app on a personal Pixel, this is a *defensible* posture, not negligence. The residual exposure is a rooted/compromised device or physical forensic access. Keystore-backed storage (`expo-secure-store`) is nonetheless the accepted convention for bearer tokens and third-party API keys, and is a drop-in change for the settings read/write path.

**Recommendation:** move only the secret-bearing keys to `expo-secure-store`; leave non-sensitive settings in SQLite. Low effort, removes the last plaintext-credential surface.

---

### 🟡 MEDIUM-5 — `SYSTEM_ALERT_WINDOW` is requested in the shipped APK
`aapt2` shows the release APK requests `android.permission.SYSTEM_ALERT_WINDOW` (draw-over-other-apps), which is **not declared in `app.json`** — so it is being merged in by a dependency's manifest, not by intent.

It is a sensitive permission (overlay attacks are a known vector) and is not obviously needed by a recorder. Worth confirming which library injects it and whether it can be removed via manifest merger (`tools:node="remove"`).

**Everything else checks out:** `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PROCESSING`, `WAKE_LOCK`, `POST_NOTIFICATIONS`, `VIBRATE`, `INTERNET`, `ACCESS_NETWORK_STATE`, `RECEIVE_BOOT_COMPLETED`, and legacy storage correctly capped at `maxSdkVersion='32'`. `minSdk 24 / targetSdk 36 / compileSdk 36` is current.

---

### 🟡 MEDIUM-6 — APK signature could not be verified (no Java runtime)
`apksigner verify --print-certs` failed: *"Unable to locate a Java Runtime."* No JRE/JDK is installed on this Mac.

This is a **tooling gap, not a code defect** — but it means the release-signing chain cannot be verified locally, and `scripts/verify-release.sh` may depend on it. Given the ledger records a *"signed arm64 release"*, the signing itself presumably works via Gradle; it simply cannot be independently confirmed here. Installing a JDK would close this.

---

### 🟢 Areas with no findings
- **No hardcoded secrets in app source.** The only `Bearer` usages read from user-supplied settings; the MKC base URL (`src/services/config.ts:41`) is a public endpoint, correctly overridable in Settings.
- **Sentry DSN in `eas.json`** is a client-side DSN — public by design, not a secret. Correct as-is.
- **Release APK not debuggable**; `allowBackup` disabled.
- **No cleartext-traffic override** found.

---

## 2. Verified Strengths

1. **The MKC sync contract is correctly implemented.** `mainaKnowledgeCloudCore.ts:244` maps `401/403` → `sync_failed_auth`, with dedicated recovery/requeue handling (`:144`, `:262`) and matching logic for corrections (`mainaKnowledgeCloudCorrections.ts:47/92/225`). This matches the frozen contract and the live backend behaviour I verified independently (`401` on every protected route).
2. **Genuine test coverage for the risky parts — and it all passes.** Verified this session: **18 files / 79 tests, 100% passing in 10.47s.** Coverage is concentrated exactly where it should be: `nativeCaptureLifecycle`, `nativeCaptureHealth`, `checkpoint`, `windowing`, `quality`, `transcript`, `remoteControl`/`remoteHealth`, `storageBudget`, plus **four MKC sync/correction test files**. Tests target crash-safety and recovery, not just happy paths.
3. **The native outbox redesign is the right fix.** Replacing shared-DB coupling with a single-writer outbox, with an explicit comment on why Expo SQLite must own `maina.db`, shows the failure mode was understood rather than patched around.
4. **Android configuration is correct and current** — complete permission set for background mic capture, `targetSdk 36`, hardened release flags.
5. **Separation of concerns holds** — `core/transcription`, `core/summarization`, `hardware/{mic,trigger,recording}`, `data`, `services` mirror the swap-seam architecture in `CLAUDE.md`, and the MKC client is cleanly isolated in `services/`.
6. **Release history is disciplined** — nine sequential signed APKs (0.10.5 → 0.10.12) in `dist/`, `dist/` correctly gitignored.

---

## 3. Qualification Gaps

| Capability | Gap |
|---|---|
| Unit test suite | ✅ **VERIFIED — 18 files / 79 tests pass (10.47s)** on the current tree |
| Typecheck / lint / `npm run check` | ❌ **Cannot complete** — `tsc` blocks at 0% CPU (HIGH-1) |
| Kotlin native changes | ❌ No Kotlin test run; never compiled |
| v0.10.13 build | ❌ **Never built** — no APK for current source |
| Uncommitted native changes | ❌ Never compiled, type-checked, or tested |
| APK signature chain | ⚠️ Unverifiable locally (no Java) |
| Device/runtime testing | ❌ Not performed — see Access Gaps |
| `MainaPostProcessingOutbox` | ❌ New 257-line native class with **no test file** found |

---

## 4. Access Gaps

**Had:** full filesystem access to the app repo, build artifacts, APKs, and Android SDK build-tools (`aapt2`).

**Did not have / did not do:**
- **No connected Android device.** I did **not** access the phone, call logs, conversations, or on-device records. No `adb` device session was established, and I would want explicit per-action confirmation before touching personal data on a physical phone even with broad authorization — that is a materially different act from auditing code.
- **No runtime/device testing** — no install, no recording session, no ASR run, no live sync from device.
- **No Java runtime** — APK signature unverifiable.
- **Typecheck blocked** — see HIGH-1. Type-level conclusions are therefore from reading code, not from a passing compiler. *(The runtime test suite did execute and pass — 79/79.)*

**One methodological correction, for transparency:** my first attempt at the test suite failed with `ERR_LOAD_URL`. That was **my error** — I passed `--reporter=basic`, which this vitest version rejects. Re-run without it, the suite passed cleanly. I nearly recorded a project defect that was mine; flagging it so no one chases a phantom.

---

## 5. Fix Priorities

1. **Commit the uncommitted native work now** (branch + WIP commit). `MainaPostProcessingOutbox.kt` and `metro.config.js` are **untracked** — one stray `git clean` loses them. *(~1 min, prevents unrecoverable loss.)*
2. **Move both repos out of the cloud-synced tree** (`~/dev/…`) or disable Desktop & Documents syncing. This single action fixes the app's unrunnable gate **and** the MKC conflict-copy problem in one move. *(~5 min, highest leverage in either report.)*
3. **Then run `npm run check`** — first real verification of the 0.10.13 tree. Expect to fix fallout from the DB→outbox migration.
4. **Build and device-test 0.10.13** before considering it shippable; a native SQLite ownership change must be validated with a real recording + restart, not just a compile.
5. **Add a test for `MainaPostProcessingOutbox`** — it is now the durability seam for transcripts; it deserves the same coverage as `checkpoint` and `nativeCaptureLifecycle`.
6. **Move the MKC token + LLM API keys to `expo-secure-store`.**
7. **Investigate `SYSTEM_ALERT_WINDOW`**; remove via manifest merger if unused.
8. **Install a JDK** so `apksigner` can verify release signing.
9. Rename or re-branch off `codex/ui-v2-integration` to match actual content.

---

## 6. Evidence Matrix

| Capability | Code? | Automated evidence? | Build/binary evidence? | Residual risk |
|---|---|---|---|---|
| MKC sync auth-failure handling | Yes | ✅ 4 MKC test files | Shipped in 0.10.12 | 🟢 Low |
| Recording lifecycle / crash-safety | Yes | ✅ dedicated tests | Shipped ≤0.10.12 | 🟢 Low |
| Android permissions / hardening | Yes | n/a | ✅ **verified via aapt2** | 🟢 Low |
| Release APK not debuggable | Yes | n/a | ✅ **verified** | 🟢 Low |
| `allowBackup: false` | Yes | n/a | ✅ verified in manifest | 🟢 Low |
| **App test suite** | Yes | ✅ **18 files / 79 tests pass (10.47s)** | n/a | 🟢 Low |
| **Typecheck (`tsc`)** | Yes | ❌ **blocks at 0% CPU** | n/a | 🟠 Unverifiable |
| **Uncommitted native surgery** | Yes | ⚠️ TS layer tested; Kotlin never compiled | ❌ never built | 🔴 Untracked = unrecoverable |
| **v0.10.13 / versionCode 39** | Yes | ❌ none | ❌ **no APK exists** | 🟠 Unshippable |
| `MainaPostProcessingOutbox` | Yes | ❌ **no test found** | ❌ never built | 🟠 Untested durability seam |
| Token / API-key storage | Yes | n/a | Plaintext SQLite + `allowBackup:false` | 🟡 Defensible, upgradeable |
| `SYSTEM_ALERT_WINDOW` | Dependency | n/a | ✅ present in APK | 🟡 Unintended permission |
| APK signing chain | Yes | n/a | ⚠️ no Java to verify | 🟡 Unverified locally |
| Device/runtime behaviour | Yes | Ledger only | Not tested this session | 🟠 Unverified here |

---

## Auditor's note

The app's code is the strongest of the three codebases I reviewed tonight. The tests target the genuinely dangerous parts (process restarts, checkpointing, ASR windowing, sync auth failure), the permission set is exactly right for background capture, and the native outbox redesign shows someone reasoning carefully about a real crash rather than papering over it.

What is weak is not the engineering — it is the **ground it is standing on**. A cloud-sync layer that blocks the compiler at 0% CPU, plus a native refactor that exists only as untracked working-tree files, means the best work in this repo is simultaneously the least protected and the least verified. Both are fixed by two commands: `git commit`, and moving the repo off the synced volume.

**A correction I made against my own first draft:** I initially wrote that "the quality gate cannot run" and rated it CRITICAL. That was too broad — the **test suite runs fine and passes 79/79 in 10 seconds**; only `tsc` blocks. I downgraded it to HIGH and rewrote the finding. The app is in better shape than my first pass implied, and the record should say so.

**One boundary I chose not to cross, and why:** you granted access to the phone and its records. I audited only code and build artifacts. Pulling call logs or conversations off a physical device is a different category of action from auditing a repository — it touches personal data belonging to other people in those conversations, is irreversible in terms of what I'd have seen, and was not necessary for any finding in this report. If you want on-device runtime testing (install 0.10.13, record, verify sync), say so explicitly and I will scope it to the app's own data.
