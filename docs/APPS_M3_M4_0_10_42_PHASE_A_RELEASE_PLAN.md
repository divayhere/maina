# Maina Apps M3/M4 0.10.42 Phase A release and audit plan

Status: Phase A source/release-plan qualification only. No native build, install,
device access, feature activation, real call, Test 3, or Test 5 is authorized by
this document.

## Immutable release identity and lineage

- Android: `com.divay.maina`, `0.10.42 (68)`.
- iOS: `com.divay.maina.staging`, `0.10.42 (24)`, Personal Team
  `9X4X3R4KCN`.
- Product pins: Android `55361a748718093239e3387022cfc7fadcf89d30`,
  iOS `8fabc83475973e3f2e3fe7273cd48c794e986686`.
- Coordination: `febe5da858b3196bccde3683e7ba4c21fa500289`.
- Backend source/deployment:
  `b879876506aaf7a18f4c2d26b9c5442629f68190` /
  `c6b5f0ce-5631-48bf-a83b-c76a2f6c99d0`.
- Final Android and iOS commits are supplied at build time and recorded in the
  completed provenance. Each must equal its upstream commit. A source gate
  verifies the canonical real path, clean tree, branch, HEAD, upstream,
  product ancestry, and coordination gitlink before clean prebuild.
- All six mobile Memory flags are false by default. Pulse has no background
  polling and is manual-only. Smart Recall has no automatic execution and is
  manual-only.

The exact reference format is `release/provenance.schema.json`; the immutable
expected values and Android/iOS allowlists are in
`release/m3-m4-candidate-plan.json`. Provenance and logs must contain no token,
credential, private key, bearer header, or customer content.

## Qualification matrix

| Layer | Required gate and evidence | Phase A status | Later execution boundary |
| --- | --- | --- | --- |
| Source/shared | Clean/upstream-exact source gate; coordination, frozen contract and generated-contract parity; TypeScript; all Vitest; lint; Expo dependency check; native recorder/API parity; renewal/single-flight and harness tests; reviewed diff | Run in Phase A, without `verify-release.sh` device preflight or native Gradle/Xcode build | Any source change invalidates artifact provenance and returns to Admin |
| Exact Android artifact | `inspect-exact-artifact.mjs android` derives package/version, apksigner result/certificate, non-debuggable/non-profileable state, exact sorted permission and component/exported/permission/process sets against the accepted 0.10.41 reference allowlist, arm64 ABI, JNI/VAD/model hashes and ZIP contents manifest. `release-provenance-cli.mjs qualify` re-hashes APK, inspection and build log | Implemented/tested against immutable 0.10.41 evidence; no 0.10.42 build | Build once only after Admin release; stop before iOS on drift, ENOSPC/I/O, signing, growth, inspection or evidence failure |
| Exact iOS artifact | `inspect-exact-artifact.mjs ios` takes the installable app ZIP and separate dSYM ZIP. It verifies strict/deep signature, exact bundle/version/build/team, arm64, designated requirement, exact app/profile entitlements including `get-task-allow`, app/team/keychain identity and no extra keys, profile UUID/name/expiry window, app/dSYM UUID equality, app tree manifest and both ZIP hashes/bytes | Implemented/tested against immutable separate 0.10.41 app/dSYM evidence; no 0.10.42 build | Run once only after Android audit acceptance and capacity remeasure; same stop conditions |
| Final provenance authorization | Both artifact records, both inspection files, both build logs, exact pins/identity/defaults and Admin actor/time are required. Validation, installation and replay freshly stat/hash both platforms plus iOS dSYM. Candidate/null records cannot authorize | Focused tamper tests pass | Admin alone changes `candidate` to `admin-approved` after both audits |
| Android post-install automation | Exact Wi-Fi Pixel identity; before-state and idle gate; no uninstall/clear/reset; one locked `adb install -r`; repull/match APK; launch/force-stop/relaunch; crash/ANR/FATAL scan; migration once; stable visible meeting/job/source IDs, outbox/pending state and no duplicate schedulers; safe route smoke; 401 clears, ordinary 403 preserves, truthful re-pair requirement; M3/M4 default-off/manual-only | Not run | Only after approved dual provenance and Admin install release |
| iOS post-install automation | Exact wired physical iPhone identity; before/after app-container inspection; single-flight `devicectl` in-place install of the app from the exact approved app ZIP; launch/terminate/relaunch; syslog/crash scan; attach-safe XCUITest; retained pipeline/outbox and no duplicate background registrations; auth/default-off parity | Not run | Only after approved dual provenance and Admin install release |
| Physical Test 3 | Owner call-interruption matrix on both phones with monitors and exact approved installed identities | Blocked | Owner-only consolidated cycle after all Admin automated gates pass |
| Physical Test 5 | Three locked offline-to-online runs per phone, including one network flap, stable identities and bounded recovery | Blocked | Owner-only consolidated cycle after Test 3 and Admin release |

Android release apps do not expose arbitrary private `/data/user/0` access to
ADB, and this plan does not invent one. Retained meeting/job/source identity is
proved through existing app UI, accessibility snapshots, sanitized app logs,
package-manager state, and sanctioned Maina/MKC API diagnostics. If an exact
identity is not exposed by those surfaces, the automation records that
limitation instead of claiming direct database proof. iOS's existing
maintenance flow can copy the app container through `devicectl` and validate
sanitized counts/SQLite integrity without placing raw content in evidence.

## Sequential capacity model

Live free space during Phase A was `25,691,540 KiB` (about `24.50 GiB`). The
earlier approved baseline was about `23.23 GiB`; APFS available space varies,
so every later transition remeasures and uses the lower live value.

The reserve is based on the actual held 0.10.41 cycle, not a fixed threshold:

| Sequential reserve | Actual prior root | Artifact | Evidence | Controlled-failure margin | Total reserve |
| --- | ---: | ---: | ---: | ---: | ---: |
| Android first | `7,420,196 KiB` maximum recorded Android root | `82,044 KiB` | `10,592 KiB` (entire prior review evidence, conservative) | `1,070,048 KiB` (entire observed pre-cycle to post-build reduction) | `8,582,880 KiB` |
| iOS after Android acceptance | `2,575,796 KiB` maximum recorded review root | `63,432 KiB` app+dSYM ZIP staging | `10,592 KiB` | `3,145,728 KiB` established separate failure/filesystem/swap reserve | `5,795,548 KiB` |
| Conservative combined sequential hold |  |  |  |  | `14,378,428 KiB` (`13.71 GiB`) |

At the Phase A live measurement, reserving the full combined amount leaves
`11,313,112 KiB` (about `10.79 GiB`). This intentionally counts full prior
roots rather than assuming current caches are reusable. After the Android
artifact is audited, remeasure before one iOS invocation; do not retry either
platform after a controlled failure.

## Hard stop and owner release

Stop before owner contact for any Critical/High issue, source/artifact/signature
or release-identity mismatch, data loss or unexplained identity change, install
ambiguity, crash/ANR, duplicate work, unexpected permission/entitlement,
insufficient profile window/capacity, or default-on M3/M4 behavior. The retained
single-flight lock is evidence when install outcome is ambiguous. Admin owns
the audit and final verdict and alone releases the consolidated owner cycle.
