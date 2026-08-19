# Maina v0.10 QC matrix

This is the test and evidence plan for the next combined implementation batch. It is intentionally stronger than the current ad-hoc APK checks so we spend build cycles on bundles of meaningful changes rather than one-off experiments.

## Automated status after the local batch — 2026-08-19

- A1 passed: `npm run typecheck`
- A2 passed: transcript chunking / block tests
- A3 passed: storage-budget tests
- A4 passed: diagnostics payload tests remain green within the full suite
- A5 passed: `scripts/verify-release.sh`
- A6 passed: native module unit tests and Kotlin compilation inside the release verifier

No APK was produced from this batch yet, so every Pixel-only row below remains pending even though the app-side implementation is now in place.

## Principles

- Release mode matters. Performance, memory, battery, and list behavior are not judged in dev mode.
- The active meeting is sacred. Cleanup and retention tests must prove that Maina never deletes the current run.
- Capture reliability outranks presentation. A plain but stable screen passes; a fancy screen that can ANR does not.
- Evidence beats feel. Each Pixel-only test should leave behind a structured diagnostic trace, an observable file result, or a retained transcript/export artifact.

## A. Automated gates before any APK

| ID | Gate | Goal | Evidence |
|---|---|---|---|
| A1 | TypeScript + existing unit suite | Prevent obvious regressions in current logic | `npm run typecheck`, `npm test` |
| A2 | Transcript block unit tests | Verify block merge, finalization, ordering, and legacy fallback shaping | New Vitest coverage |
| A3 | Storage-pressure unit tests | Verify free-space preflight, retention ordering, and active-run protection | New Vitest coverage |
| A4 | Diagnostics payload tests | Ensure structured logs never carry transcript text in the hot path | Extended Vitest coverage |
| A5 | Release verifier | Fail the build if transcript UI still uses unsafe rendering or if the hot path still queues whole-text transcript artifacts | `scripts/verify-release.sh` |
| A6 | Native compile/tests | Keep native diagnostics and service code buildable after schema changes | Gradle compile + native unit tests |

## B. Pixel release-mode functional tests

| ID | Scenario | Why it exists | Pass condition |
|---|---|---|---|
| B1 | Fresh launch and schema migration | Verify the new transcript-block schema does not break startup | App launches cleanly; no init error screen; meetings list opens |
| B2 | Legacy meeting read | Verify old blob-only meetings still open safely | Old meeting opens without ANR and can export |
| B3 | New short meeting | Verify block-backed capture end-to-end | New meeting records, stops, and opens with timestamped transcript blocks |
| B4 | Retry transcription from saved audio | Verify re-pass now writes blocks instead of one blob | Re-pass completes and meeting remains readable/exportable |
| B5 | Export `.md` / `.txt` | Verify export path is async and stable on long text | Share/copy/export succeeds without UI freeze |
| B6 | Interrupted-meeting recovery screen | Verify a killed recording does not immediately remount a giant transcript | Recovery screen opens first and exposes safe next actions |
| B7 | Lock-screen remote control | Preserve the existing core use case | Start, pause/resume, and stop still work from the clicker path we support |
| B8 | Mic-route transition | Preserve Hollyland/phone fallback continuity | Route-change event is logged and capture continues with bounded gap |

## C. Long-session reliability tests

| ID | Scenario | Why it exists | Pass condition |
|---|---|---|---|
| C1 | 3-hour screen-off capture while charging | This is the real workload | No ANR, no lost meeting row, no unusable transcript screen |
| C2 | Open/close app repeatedly during long capture | Reproduces the previously dangerous moment | UI stays responsive and active recording survives |
| C3 | Open long meeting detail after capture | Direct regression check for the 72-minute failure class | Scrolling is responsive; no input-dispatch ANR |
| C4 | Export after long capture | Verifies large transcript handling beyond viewing | Export finishes and shared file is complete |
| C5 | Force process death mid-recording | Validates crash-safe recovery path | Audio and transcript checkpoints recover into a safe recovery screen |

## D. Storage and cleanup tests

| ID | Scenario | Why it exists | Pass condition |
|---|---|---|---|
| D1 | Low-space preflight before recording | Avoid starting a meeting when failure is predictable | App warns clearly and records diagnostics |
| D2 | Low-space export/re-pass | Avoid late-stage failure surprises | Export/re-pass fails safely with actionable status if space is insufficient |
| D3 | Staging cleanup action | Make repeated testing practical | Old test meetings/audio can be purged without touching the active run |
| D4 | Retention budget enforcement | Keep recovery storage predictable | Oldest-safe-first cleanup occurs and the active meeting remains intact |

## E. Battery and performance evidence

| ID | Scenario | Why it exists | Evidence to capture |
|---|---|---|---|
| E1 | Armed idle, screen off, 30-minute sample | Verify remote readiness is not draining the phone | CPU sample, battery delta, wake-lock state |
| E2 | Active recording, screen off, 60-minute sample | Verify recording cost is stable after transcript changes | CPU sample, battery delta, memory growth, diagnostics heartbeat |
| E3 | Long-session memory slope | Confirm the block architecture stops unbounded text growth | Memory/process diagnostics across the 3-hour run |
| E4 | Open long transcript after capture | Confirm rendering budget remains healthy | No ANR, no sustained memory spike after opening detail screen |

## F. Nice-to-have tests if time remains

| ID | Scenario | Reason |
|---|---|---|
| F1 | Hinglish script with intentional switching every 20–30 seconds | Better compare language-switch behavior between builds |
| F2 | Phone reboot then re-arm flow | Confirm the "open once after reboot" assumption still holds |
| F3 | Audio deletion after successful export/re-pass | Verify maintenance tools do not orphan UI state |

## Recommended batch boundary before the next APK

The next build should include only the following grouped changes together:

1. Transcript blocks plus FlashList viewer.
2. Recovery-first routing.
3. Removal of automatic transcript-text artifact uploads.
4. Storage-pressure and staging-cleanup controls.
5. Durable long-session diagnostics and release/test gates.

If those five land together, the next APK will be worth testing. If only one or two land, we spend a build token without learning enough.
