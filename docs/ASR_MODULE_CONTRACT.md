# Maina local-ASR module contract

This document is the integration seam for every future ASR engine. New staging
branches must preserve this contract or add a new ADR before changing it.

## Stable inputs

```ts
type AudioWindow = {
  meetingId: string;
  recordingId: string;
  chunkId: string;
  sourceUri: string;        // immutable finalized local WAV/PCM source
  startMs: number;          // meeting-relative, inclusive
  endMs: number;            // meeting-relative, exclusive
  overlapBeforeMs: number;
  sampleRateHz: number;
  channels: number;
  sourceRoute?: string;
};

type AsrRequest = {
  engineId: string;
  engineVersion: string;
  window: AudioWindow;
  languageHint?: 'auto';    // user-facing language selection is forbidden
  attempt: number;
  reason: 'primary' | 'retry' | 'manual-reprocess';
};
```

## Stable outputs

```ts
type AsrResult = {
  request: AsrRequest;
  outcome: 'success' | 'empty' | 'failed' | 'suspicious';
  text: string;
  language?: string;
  startedAtMs: number;
  endedAtMs: number;
  processingMs: number;
  diagnostics: {
    modelPackId: string;
    modelPackVersion: string;
    peakMemoryMb?: number;
    truncationSuspected: boolean;
    repetitionSuspected: boolean;
    speechExpected: boolean;
    errorCode?: string;
  };
};
```

## Invariants

- The adapter cannot delete or rewrite source audio.
- The adapter cannot mark a meeting complete; only the coverage controller can.
- One adapter failure is a retryable result, never a recording failure.
- All output must carry engine and model-pack version metadata.
- UI receives paged transcript blocks, never a model-owned whole-transcript
  buffer.

## Required adapter responsibilities

1. Verify model-pack files and checksums before loading.
2. Bound memory and concurrency: one model decode at a time on the phone.
3. Return a terminal structured result for every request.
4. Detect model output limits/truncation when the runtime exposes them.
5. Never rely on a meeting-level language choice; each window is independent.

## Current planned adapters

| Adapter | Status | Role |
|---|---|---|
| `qwen3-0.6b-int8` | qualification candidate | primary multilingual local ASR |
| `whisper-small` | future fallback candidate | retry path for suspicious English-heavy windows |
| `hinglish-swift` | future fallback candidate | retry path for suspicious Hindi/Hinglish windows |
| Android SpeechRecognizer | legacy preview only | non-authoritative live preview during transition |

