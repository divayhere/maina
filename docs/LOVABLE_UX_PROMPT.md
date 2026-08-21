# Maina — UI/UX Design Brief (paste into Lovable)

> Paste everything below into Lovable. Attach the 6–7 current-app screenshots where marked at the very end.

---

## Your role

You are a world-class product designer. Design the complete UI/UX for a **mobile app** (Android, phone-shaped screens) called **Maina**. The bar is a single reaction from anyone who opens it: *"this is insane — the UX is so simple."* Modern, minimal, confident, premium — with tasteful pops of colour and small moments of delight. It should feel like a brand-new category of app, not a generic template.

**You own the design.** I am giving you the *ingredients*, not the recipe. You decide the flow, the navigation, the screen order, the interactions, the information architecture, the motion, the empty states, the microcopy, and how every function is represented. Use your own judgment and taste.

## Read this twice — creative freedom

- I am **not** prescribing screens, flow, tabs, or interactions. **Invent them.**
- Do genuine, modern UX research and let it show. Study the best-in-class for feel (e.g. Granola, Superhuman, Linear, Arc, Raycast, Notion Calendar, Bear, Things) and then go **beyond** them — don't imitate.
- Where I list a feature, config, or state, treat it as *"this must be representable somewhere in your design"* — **you** decide where it lives, how it's grouped, whether it's merged into something more elegant, and how it looks and behaves.
- **The attached screenshots show what the app currently does. The current design is NOT good — do not copy it, do not preserve it, do not let it anchor you.** They are there only so you understand the *functionality that exists*, never as a design to match. If your instinct disagrees with everything in them, follow your instinct.

## What Maina is (the essence)

Maina is a **personal, private meeting companion**. You press a button (a small physical clicker, or on-screen) and it starts capturing a meeting — in person, or sitting next to a laptop on a video call. It transcribes **on the phone itself** (offline, free, private), in **English, Hindi, and mixed Hindi-English (Hinglish)**. The raw transcript is the memory. Afterward, a chosen AI turns each meeting into a clean **"meeting packet"**: a summary, the decisions taken, open questions, and action items / to-dos. Everything is searchable, and any meeting can be exported/shared as a simple text/markdown file.

It replaces both a meeting-notes service (like Fireflies/Otter) and an AI wearable — but it's yours, on your phone, with no subscription for the capture.

The feeling to design for: **effortless trust.** A user in a real business meeting must feel, at a glance, that it's capturing and that nothing will be lost — without any anxiety, clutter, or fiddliness.

## The medium (a constraint about the canvas, not your creativity)

- Design a **mobile app** — phone screens, thumb-reachable, one clear thing at a time. Not a desktop web dashboard.
- Support **light and dark**. Assume it's used one-handed, often glanced at mid-conversation.
- Keep it fast and calm; this is a tool people rely on, not a toy.

---

## The ingredients — everything the product must be able to express

Below is the full surface area of the product. **You decide how to organise, name, combine, hide, progressively-disclose, or elevate any of it.** Nothing here is a layout instruction.

### A. The core objects the app is about
- **Meetings** — each has: a short title, date/time, duration, a live/processing/done status, a transcript, and (once generated) a packet (summary + decisions + open questions + to-dos), a language, and an "audio still kept?" state.
- **Transcript** — potentially long (meetings can run 1–3 hours). Stored as time-stamped blocks. Must stay smooth to read even when huge. A future "who said what" (speaker labels) may be added — leave room for it conceptually.
- **Meeting packet** — the AI output: **Summary**, **Decisions**, **Open questions**, **To-dos** (each to-do ideally traceable to the transcript line it came from).
- **To-dos (global)** — all action items from all meetings, gathered in one place, tickable, each linking back to its source meeting.

### B. Capture & live states (the emotional core — represent these beautifully)
The app must clearly, calmly communicate which of these it is in, at a glance:
- **Idle** — nothing happening.
- **Armed / ready** — the physical button is live and will start a recording even from the lock screen; the app can be closed.
- **Recording (live)** — actively capturing, with an elapsed timer, a live view of the transcript appearing, and a sense of "audio is being heard" (input level).
- **Paused / resumed.**
- **Processing / transcribing** — the on-device engine is turning audio into text (can lag slightly behind and catch up — represent "it's working through it").
- **Summarizing** — the cloud AI is generating the packet.
- **Done.**
- **Recovering** — the app was killed or crashed mid-meeting and is restoring what was captured (nothing lost).
- **Error / needs attention** — something went wrong; say what and how to fix, calmly.

### C. Microphone & input (represent the *status*, you invent the visual language)
- Which mic is in use (phone mic, or an external clip-on/USB mic).
- **External mic connected / disconnected** — and, mid-meeting, a clear but non-alarming signal like *"switched to phone mic."*
- Input level / "it's hearing you" feedback while recording.

### D. The physical button / clicker (configuration + status)
- Pairing/setting up a small physical clicker so recording can be started/stopped hands-free, even with the screen locked.
- **Button configuration**: mapping what a single press / double press does (e.g. start-pause vs stop) — you decide how to present this simply.
- **Armed vs not-armed** status, and a clear, friendly path if a required Android permission/accessibility setting is off and the button won't work — the user should understand *"your button is ready"* or *"one tap to make your button work."*

### E. AI provider & keys (configuration — rationale is *yours* to design)
- The user picks which AI generates the packet, from a set of options (multiple leading providers, plus a custom endpoint). They paste their own API key, and the app confirms whether the key works.
- Choosing a model. A toggle for whether packets are generated automatically after each meeting or on demand.
- **You decide how to make provider selection feel effortless and trustworthy** — do your own research on how great apps present "bring your own AI key," validation, and errors. Don't over-explain; make it obvious.

### F. Transcription settings
- Language preference for capture (English / Hindi / Hinglish / automatic).
- The on-device transcription engine's readiness (a model may need a one-time download; show progress and "ready").

### G. Privacy & data
- A clear, reassuring statement that **audio and transcription stay on the phone**; only the transcript text goes to the chosen AI for the summary, and only if the user set that up.
- **Audio retention**: transcripts are kept; audio is pruned automatically after a while (time/size based) — the user can see how much audio is stored and delete it per meeting.

### H. Diagnostics / system health (represent, don't clutter)
- A quiet place that shows the app is healthy: capture service running, storage available, model ready, recent problems (if any), and a way to share logs. Make this feel like a calm "everything's fine" — not an engineering panel.

### I. Actions the user takes (you place and style them)
Start / pause / stop (by button or on-screen) · generate or regenerate a meeting packet · mark a to-do done · export/share a meeting as text/markdown · re-transcribe a saved recording · rename or delete a meeting · search across meetings · download the transcription model · set up the clicker · enter/validate an AI key · delete stored audio.

### J. The hard-to-screenshot, invisible-but-essential functions — I especially want *your* creative representation of these
- "The app is armed and will capture even while locked / in my pocket."
- "It's transcribing in the background and catching up."
- "It's currently using [chosen AI] to write the summary."
- "The recording is safe even though the screen is off."
- Why a given AI/model is selected, and how switching is safe for past meetings.
These are the moments where a boring app shows a spinner and a great app makes you *feel calm and in control.* Invent that.

---

## Design direction

- **Modern, minimal, premium.** Generous whitespace, real typographic hierarchy, one clear focus per screen.
- **Tasteful colour pops** — not a rainbow, not corporate blue. A confident accent (or a small, well-chosen palette) used with restraint, plus a distinct, unmistakable "recording is live" signal.
- **Personality without noise** — a little wit in empty states and microcopy; delightful micro-interactions and motion where they *earn* their place; never gimmicky.
- **Trust cues everywhere** — the user should always know what's happening and that nothing is lost.
- **A pace that feels fast and quiet.** Think "premium instrument," not "busy dashboard."
- Reaction target: *"fuck, this is insane — the UX is so simple."*

## What to deliver

Design the full app: every screen and state above, as a coherent product with its own visual system (colour, type, spacing, components, iconography, motion), in **light and dark**, for a phone. Show the primary journeys and the important states — but the *structure and flow are yours to invent.* Make it feel like one confident, original product, not assembled parts.

---

## The current app, as it exists today (context only — DO NOT copy or preserve)

The app already works functionally, but **its design is generic and not good.** This section — and the attached screenshots — exist **only** so you understand *what functions exist*. **Reimagine all of it. Throw the entire visual approach out.**

What it currently does (observed, dark theme):
- **Home / Meetings:** a large flat purple hero card ("Maina" + a one-line tagline + count pills like "8 meetings" / "4 ready packets" + a "Start recording" button), then a "Recent meetings" list of cards — each with a title, `date · time · duration`, a 2-line preview, small chips ("0 decisions", "1 open to-dos", "1 questions"), and a status badge ("Recorded" / "Ready"). A bottom tab bar: **Meetings** (mic), **To-Dos** (check), **Settings** (gear).
- **Meeting detail:** a purple hero (title, `date · time · duration · auto`, chips like "Packet ready", "N transcript blocks", "N open to-dos"), a segmented **Overview | Transcript** toggle, then stacked cards — **Summary** (with "Copy summary" / "Share meeting"), **Decisions**, **Open Questions**, **To-dos** — plus a delete action. (The AI summaries it produces are real and coherent.)
- **Settings:** an "AI packet generation" block — an "Auto-generate after every meeting" toggle, provider chips (Gemini, ChatGPT, Claude, Grok, DeepSeek, Custom OpenAI-compatible), a masked API-key field, an auto-model note, and a "Validate & save AI setup" button; further down live transcription/language, the on-device model status, audio-retention controls, the physical-button/accessibility setup, and a diagnostics/system-status area.

**What's wrong with the current design (do the opposite):** it leans on big flat purple blocks and lots of grey explanatory paragraph text; it's chip-heavy and reads like a settings form; every screen is the same generic card-stack; there is little hierarchy, delight, motion, or distinctiveness — it feels template-y and "AI-built." **You are free — and expected — to discard this entire look and invent something original, premium, and unmistakably yours.**

**[ATTACH THE 6–7 CURRENT-APP SCREENSHOTS HERE — reference only, never a design to match]**
