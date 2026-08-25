# Maina local-first meeting engine source ledger

Date: 26 August 2026  
Purpose: claim-to-source ledger for `LOCAL_FIRST_MEETING_ENGINE_RESEARCH_2026-08-26.md`. Primary/official sources are preferred; public application repositories are treated as implementation examples, not authority.

| Claim/use | Source | Authority | Maina implication |
| --- | --- | --- | --- |
| Microphone capture belongs in a microphone foreground service; background starts are restricted | [Android foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types), [background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) | Android official | Keep Maina's armed microphone FGS and explicit user/clicker initiation. |
| `mediaProcessing` has a six-hour aggregate background limit and requires `onTimeout()` cleanup | [Android foreground-service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout) | Android official | Keep checkpointing; test forced timeout; do not imply endless uninterrupted background ASR. |
| WorkManager supports persistent/unique/retried work, but long workers have Android 16 quotas | [Persistent work](https://developer.android.com/develop/background-work/background-tasks/persistent), [long-running workers](https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running) | Android official | Use unique work for reconciliation and bounded continuation, not for microphone ownership. |
| Audio routes can change while recording; actual and preferred devices differ | [AudioRouting](https://developer.android.com/reference/android/media/AudioRouting), [AudioRecord](https://developer.android.com/reference/android/media/AudioRecord) | Android official | Continue monitoring actual routed device and rebuild capture only when required. |
| Competing ordinary apps can silence a recorder and routing/preprocessing can change | [Sharing audio input](https://developer.android.com/media/platform/sharing-audio-input) | Android official | Monitor `isClientSilenced`, device, and format; no app can guarantee mic ownership during every competing capture. |
| Android exposes allocatable storage and app-private storage lifecycle | [App-specific files and free-space query](https://developer.android.com/training/data-storage/app-specific), [StorageManager](https://developer.android.com/reference/android/os/storage/StorageManager) | Android official | Preflight model/audio space and verify cleanup rather than swallowing file errors. |
| `VOICE_RECOGNITION` should not receive default NS/AGC | [AOSP preprocessing guidance](https://source.android.com/docs/core/audio/implement-pre-processing) | Android/AOSP official | Do not globally “super-amplify” or denoise the capture path. |
| Qwen3-ASR 0.6B supports English and Hindi plus automatic language recognition | [Qwen3-ASR model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Model owner | Qwen remains Maina's primary multilingual high-tier model. |
| Qwen's official long-audio splitter searches low energy and preserves every sample with no gaps/overlaps | [Qwen3-ASR `split_audio_into_chunks`](https://github.com/QwenLM/Qwen3-ASR/blob/main/qwen_asr/inference/utils.py) | Model owner code | Replace blind midpoint retry with low-energy sample-exact subdivision. |
| sherpa Qwen advises shortening audio or increasing bounds when capped | [sherpa Qwen3 implementation](https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-recognizer-qwen3-asr-impl.cc) | Runtime owner code | Prefer bounded recursive shorter leaves over large mobile KV limits. |
| Official sherpa example uses 512 total / 128 new tokens and two threads | [sherpa Qwen C++ example](https://github.com/k2-fsa/sherpa-onnx/blob/master/cxx-api-examples/qwen3-asr-cxx-api.cc) | Runtime owner code | Keep Maina's current bounded recognizer policy. |
| sherpa-onnx supports Android ASR, VAD, enhancement, diarization, and speaker embeddings | [sherpa-onnx repository](https://github.com/k2-fsa/sherpa-onnx) | Runtime owner | Maintain one modular runtime seam; add optional capabilities only after benchmark qualification. |
| Whisper Android guidance recommends tiny/base; model memory grows sharply | [whisper.cpp Android example](https://github.com/ggml-org/whisper.cpp/blob/master/examples/whisper.android/README.md), [whisper.cpp model memory](https://github.com/ggml-org/whisper.cpp/blob/master/README.md) | Runtime owner | Do not return to Whisper large/turbo on general Android; benchmark small tiers explicitly. |
| A production-like local Android recorder uses AudioRecord + FGS + VAD + durable local files | [`android-local-transcribe`](https://github.com/mtib/android-local-transcribe) | Public implementation example | Corroborates Maina's native capture/service/storage split; its Parakeet model lacks Hindi, so do not copy its model choice. |
| Device memory facts are available at runtime | [ActivityManager.MemoryInfo](https://developer.android.com/reference/android/app/ActivityManager.MemoryInfo.html) | Android official | Gate large model packs by device tier and current memory pressure. |
| User-initiated large downloads have a dedicated Android mechanism | [User-initiated data transfer](https://developer.android.com/develop/background-work/background-tasks/uidt) | Android official | Use UIDT on modern Android for the 1 GB model pack; WorkManager foreground fallback on older versions. |

## Benchmark artifact ledger

Temporary working directory: `/private/tmp/maina-asr-research`.

- source clips: `converted/HINDI.wav`, `converted/ENGLISH.wav`;
- Qwen baseline: `qwen-hindi.json`, `qwen-english.json`;
- Omnilingual baseline: `omni-hindi.json`, `omni-english.json`;
- Whisper-small baseline: `whisper-hindi.json`, `whisper-english.json`;
- current one-level behavior: `qwen-hindi-recovery.json`, `qwen-english-recovery.json`;
- official-inspired sample-exact splitting: `qwen-hindi-smart8.json`, `qwen-english-smart8.json`;
- bounded recursive recovery: `qwen-hindi-recursive.json`, `qwen-english-recursive.json`.

The report records aggregate results so the decision remains durable even if temporary model/audio artifacts are later removed.

