# Maina QA audio corpus

Use these inputs to qualify local capture and transcription without adding
copyrighted audio to Git or the APK. Record their playback through the same
phone/microphone route used for real meetings; do not feed an original file
directly into production capture.

| ID | Source | Purpose | Suggested run |
| --- | --- | --- | --- |
| `yt-indian-english-podcast-8m` | https://www.youtube.com/watch?v=4V3vIGkw9x0 | Real Indian-English business/podcast cadence | 60–120 seconds, then one full run |
| `yt-english-short-19s` | https://www.youtube.com/watch?v=jNQXAC9IVRw | Fast public English capture smoke | One complete 19-second run |
| `local-hindi-hinglish-3m` | User-provided `HINDI.mp3` (not committed) | Hindi/Hinglish words, code switching | 60 seconds then full clip |
| `local-indian-english-3m` | User-provided `English in Indian Accent + English Normal.mp3` (not committed) | Indian English recognition | 60 seconds then full clip |
| `tts-known-sentence` | Controlled local TTS, exact script below | Deterministic recovery and completeness checks | 30–45 seconds |

## Controlled sentence

> This is a Maina qualification recording. The project decision is to keep
> transcription local and preserve recoverable audio for seven days. The next
> action is to verify the meeting summary and cloud sync.

## Pass criteria

1. Recording remains in one meeting through the chosen input route.
2. Finalized audio is durable before post-processing starts.
3. Complete transcription unlocks notes and cloud sync.
4. A forced partial run exposes a visible recovery action and only re-runs
   failed ASR windows; completed blocks remain intact.
5. No FATAL exception, ANR, or loss of the source recording.

Record the device route, approximate distance, playback volume, and whether
the external microphone was used alongside each result. Do not store meeting
content or provider credentials in this document.
