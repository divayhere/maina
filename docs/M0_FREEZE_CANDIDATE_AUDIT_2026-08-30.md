# M0 freeze-candidate audit — 2026-08-30

## Verdict

**AT RISK / physical replay pending.** The corrected Android and iOS candidates
are installed safely and the non-manual evidence is strong, but neither M0 nor
the Apps release is ready to freeze until physical Tests 3 and 5 pass.

## Proven now

| Area | Evidence | Result |
| --- | --- | --- |
| Android source | `8bb0a1c`; branch pointer `dddc882` | Pushed and clean |
| iOS source | `ff43a64`; branch pointer `10e4b23` | Pushed; only the two preserved user-owned harness files remain dirty |
| Coordination | `49c5e0a` | Verified at 115 events / 51 items |
| Android installed build | 0.10.34 (60), APK SHA-256 `f7d10fa98921db8effcb766b753d3d3b48ee156ab2841677ff5bda992e99e626` | Exact Pixel, update-in-place |
| Android data preservation | Original install time and CE/DE data inodes unchanged; Home still shows 32 recordings | Passed |
| Android upgrade startup | Schema 15 initialized automatically on the corrected install and same-APK replay; two additional force-stop launches passed | Passed on this candidate; historical one-off refusal remains a final soak residual |
| iOS installed build | 0.10.34 (16), `com.divay.maina.staging` | Exact iPhone 15, update-in-place |
| iOS data preservation | 38 meetings, 916 transcript blocks, 34 to-dos, 221 stages before and after install; SQLite integrity `ok` | Passed |
| iOS signing | Team `9X4X3R4KCN`; profile expires `2026-09-02T19:10:10Z` | Valid Personal Team build; weekly renewal remains required |
| Focused reliability tests | Android 56/56; iOS 58/58 | Passed |
| Full candidate tests | Android 197/197; iOS 203/203 | Passed before install |
| Static gates | Typecheck, native verifier, contract pin `57cbb52`, coordination | Passed on both branches |
| Contract boundaries | No new store, auth/token route, provider path, prompt path, source key, packet shape, or retrieval engine | Passed |
| Feature activation | Memory A-C flags resolve false unless explicitly injected | Default-off |

## Correction-diff review

- One root pipeline-recovery cycle is protected by an in-flight promise.
- One packet poll chain is protected by an in-flight promise and one timer.
- React listeners unsubscribe on cleanup; meeting screens reload durable SQLite
  state instead of accepting mutable event payloads.
- Packet application remains serialized across meetings to protect the shared
  Expo SQLite connection.
- Packet retries are durable and capped at a three-hour delay; hot polling skips
  future-due retry work.
- Source-sync requests retain their frozen JSON and in-flight meeting-ID
  deduplication. A recovery cycle may make a bounded immediate second attempt,
  but a successful canonical source is not requeued.
- iOS transcription uses a per-meeting continued-processing identifier and
  cancels only the superseded request. Completion cancels the request and ends
  the short fallback assertion.
- iOS call recovery preserves the same meeting and closed WAV chunks, filters
  self-generated category route changes, and bounds retries to approximately
  30 seconds. Whether iOS grants enough background time after real calls remains
  a physical Test 3 question, not an automated claim.
- Android/iOS reliability-core TypeScript files are byte-identical. Remaining
  `_layout.tsx` differences are platform adapters/automation; meeting-detail
  branch differences predate this correction and are not activation evidence.

## Preserved state needing observation

The iPhone has one durable meeting with complete 42/42 local transcription and
a retryable cloud-notes job. It remains preserved, not deleted or rewritten.
Its retry state is useful supplemental evidence but does not replace Test 5,
which requires a controlled offline run and network flap.

## Manual gates still open

1. Test 3: answered and rejected calls on both exact devices, automatic
   background resume, consistent UI/native state, call-audio exclusion, post-call
   speech, same meeting identity, and terminal pipeline.
2. Test 5: offline local capture/ASR, unattended reconnect, one network flap,
   persisted UI convergence, and no duplicates or manual Retry.
3. Admin's independent final upgrade/soak gate for the historical Android first
   post-upgrade database refusal, even though it did not reproduce on 0.10.34.
4. Memory Releases B/C and visible activation remain sequenced after M0 physical
   closure. Current Memory surfaces stay default-off and are not release claims.

## Not defects in this audit

- One bounded iPhone CoreDevice query became temporarily stuck after repeated
  screenshots. USBMUX continued to identify the exact USB iPhone 15 and the app
  had already passed launch and targeted SQLite checks. This is a Mac/device
  control-plane residual; morning preflight must nevertheless pass before tests.
- The Test 3 monitor armed overnight captured no recording or call because the
  owner was unavailable. It was closed at 1.6 MB and explicitly marked
  `gate_result=not_run`; it is not pass evidence.

## Rollback and data protection

- Do not uninstall either app.
- Do not clear app data or reset either database.
- Android rollback is another signer-matched `adb install -r` only after version
  compatibility is verified.
- iOS renewal/replacement keeps the same bundle identifier, Team ID, and
  application identifier and uses an in-place install.
- Use only targeted SQLite/log/screenshot extraction; never copy a full iPhone
  container for routine qualification.

