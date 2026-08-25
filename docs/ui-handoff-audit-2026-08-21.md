# Maina UI Handoff Audit

Date: 2026-08-21
Branch: `codex/ui-v2-integration`
Inputs reviewed:

- `/Users/divay/Downloads/maina-ui-handoff-v2.zip`
- `/Users/divay/Downloads/maina-ux-spec-v2 (1).md`
- Current Expo React Native app on `codex/v0.8-observability`

## Verdict

The handoff is good enough to adopt as the new product direction, but it is not
safe to merge literally. The visual language is strong and the state model is
much more truthful than the previous UI, yet the package is still a web
prototype with mock data and a few assumptions that do not match the native app.

## Keep

- Light-only teal / mint / white visual system.
- Simpler information architecture: Home, To-dos, Settings, Record, Meeting.
- Truthful progress language: no fake percentages, no fake mic meter.
- Notes setup-required flow when no AI key is connected.
- Transcript as durable source of truth, audio as temporary recovery material.
- Cleaner copy: "recording", "notes", "transcript", "to-do".
- Stronger empty states, interrupted states, and failed-notes states.

## Reshape Before Integration

1. Language field
   Current handoff narrows `lang` to `en-IN | hi-IN`.
   Native app stores `meeting.language?: string | null` and can surface `auto`
   or other detected values.
   Integration rule: keep the UI label friendly, but do not narrow the runtime
   data contract.

2. Transcript block shape
   Prototype uses `{ atMs, text }`.
   Native app stores sequence, status, startedAt, endedAt, language, and text.
   Integration rule: UI can render a simplified view, but native components must
   map from the richer stored block model.

3. Loading model
   Prototype assumes near-synchronous local reads and avoids explicit loading.
   Native app uses async repository reads and detail polling.
   Integration rule: add lightweight loading and refresh states so screens do
   not flash empty states during load.

4. Error hygiene
   Handoff correctly says provider/model text must never leak into the UI.
   Native app still has paths where raw provider text can surface.
   Integration rule: centralize human-safe error normalization before final UI
   wiring.

5. Drawer and help flows
   Handoff includes a real drawer, help page, and feedback link.
   Native app does not yet have the shared drawer shell.
   Integration rule: implement the drawer as a native shared component; do not
   ship a burger icon that has no action.

6. Typography
   Handoff specifies Plus Jakarta Sans, but the production app does not yet ship
   the font asset.
   Integration rule: either add the font properly with Expo font loading or
   tune the typography to the system font instead of pretending the custom font
   exists.

7. Small-screen stress
   Screenshots are based on Pixel 9 Pro logical size.
   Integration rule: test on narrower Android widths and long content strings,
   especially:
   - meeting header actions
   - settings provider chips
   - notes footer actions
   - transcript rows
   - bottom bar + FAB overlap

## Do Not Port Directly From The Prototype

- `src/lib/maina-data.ts`
  Reason: mock data, narrowed language type, UTC-only format assumptions.

- `src/lib/maina-settings.ts`
  Reason: prototype-only in-memory settings that do not reflect production
  persistence.

- Web layout from `src/components/maina/ui.tsx`
  Reason: visual reference only; needs native-safe spacing, gestures, safe-area
  handling, and route behavior.

## Native Integration Rules

1. Preserve the current recording, transcription, summary, and todo behavior.
2. Rebuild the handoff visually through shared RN components instead of copying
   the web component tree.
3. Put all state-to-copy mapping behind one native helper so Home and Meeting
   cannot drift.
4. Keep destructive actions explicit and never use decorative controls without a
   real action.
5. Prefer stacked actions over cramped horizontal action rows on detail screens.

## Recommended Build Order

1. Tokens, theme, spacing, and light-only shell.
2. Shared components: top bar, drawer, bottom bar, FAB, chip, banner, progress,
   empty states.
3. Home and To-dos.
4. Meeting detail.
5. Settings and Help.
6. Record screen polish after the shell is stable.

## Risk Watchlist

- Raw provider errors reaching the meeting detail view.
- Pixel-safe spacing that breaks on smaller Android screens.
- Drawer and FAB colliding with Expo tabs behavior.
- Detail-screen action density becoming cramped when translated from web.
- Future mismatch between UI spec words and actual backend statuses.
