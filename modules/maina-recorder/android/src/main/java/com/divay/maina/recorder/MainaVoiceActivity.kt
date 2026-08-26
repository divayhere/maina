package com.divay.maina.recorder

import android.content.Context
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import kotlin.math.max

/**
 * A deliberately conservative voice-activity gate for post-capture ASR.
 *
 * This is not a denoiser and it never changes the saved WAV.  Its job is only
 * to decide whether a blank Qwen result is normal silence/no-content or a
 * genuine speech-recognition problem worth recovering.  Ambiguous audio is
 * still passed to Qwen once; Maina must prefer retaining a quiet word over
 * being clever about deleting it.
 */
internal class MainaVoiceActivity(private val context: Context) {
    @Volatile private var vad: Vad? = null

    @Synchronized
    fun assess(samples: FloatArray): Assessment {
        if (samples.isEmpty()) return Assessment.silence()
        val detector = vad ?: createDetector().also { vad = it }
        detector.reset()
        val scores = ArrayList<Float>((samples.size + FRAME_SAMPLES - 1) / FRAME_SAMPLES)
        var offset = 0
        while (offset < samples.size) {
            val frame = FloatArray(FRAME_SAMPLES)
            val count = minOf(FRAME_SAMPLES, samples.size - offset)
            samples.copyInto(frame, destinationOffset = 0, startIndex = offset, endIndex = offset + count)
            scores += detector.compute(frame)
            offset += count
        }
        detector.reset()
        return MainaVoiceActivityPolicy.assess(scores)
    }

    @Synchronized
    fun release() {
        runCatching { vad?.release() }
        vad = null
    }

    private fun createDetector(): Vad {
        val model = verifiedModelFile()
        return Vad(
            assetManager = null,
            config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(
                    model = model.absolutePath,
                    threshold = MainaVoiceActivityPolicy.SPEECH_THRESHOLD,
                    minSilenceDuration = MainaVoiceActivityPolicy.MIN_SILENCE_SECONDS,
                    minSpeechDuration = MainaVoiceActivityPolicy.MIN_SPEECH_SECONDS,
                    windowSize = FRAME_SAMPLES,
                    // Every Maina ASR window is <= 15 seconds.  Do not make
                    // VAD split it arbitrarily; Qwen owns transcript chunks.
                    maxSpeechDuration = 30f,
                ),
                sampleRate = SAMPLE_RATE,
                numThreads = 1,
                provider = "cpu",
                debug = false,
            ),
        )
    }

    /** Copy once to private storage, verify, then atomically expose it to JNI. */
    private fun verifiedModelFile(): File {
        val directory = File(context.filesDir, "models/maina-vad")
        check(directory.exists() || directory.mkdirs()) { "Could not create Maina VAD model directory" }
        val destination = File(directory, MODEL_FILE)
        if (destination.isFile && sha256(destination) == MODEL_SHA256) return destination

        val partial = File(directory, "$MODEL_FILE.partial")
        context.assets.open(MODEL_FILE).use { input ->
            FileOutputStream(partial, false).use { output -> input.copyTo(output) }
        }
        check(sha256(partial) == MODEL_SHA256) { "Bundled Maina VAD model checksum did not match" }
        if (destination.exists()) check(destination.delete()) { "Could not replace invalid Maina VAD model" }
        check(partial.renameTo(destination)) { "Could not finalize Maina VAD model installation" }
        return destination
    }

    private fun sha256(file: File): String = MessageDigest.getInstance("SHA-256")
        .digest(file.readBytes())
        .joinToString("") { "%02x".format(it) }

    data class Assessment(
        val decision: Decision,
        val maxProbability: Float,
        val voicedFrames: Int,
        val longestVoicedRunFrames: Int,
    ) {
        val speechMs: Long get() = voicedFrames.toLong() * FRAME_SAMPLES * 1000L / SAMPLE_RATE
        val requiresRecoveryAfterBlank: Boolean get() = decision == Decision.SPEECH
        val shouldTranscribe: Boolean get() = decision != Decision.SILENCE

        fun asMap() = mapOf(
            "decision" to decision.wireValue,
            "maxProbability" to maxProbability,
            "speechMs" to speechMs,
            "voicedFrames" to voicedFrames,
            "longestVoicedRunFrames" to longestVoicedRunFrames,
        )

        companion object {
            fun silence() = Assessment(Decision.SILENCE, 0f, 0, 0)
        }
    }

    enum class Decision(val wireValue: String) {
        SILENCE("silence"),
        UNCERTAIN("uncertain"),
        SPEECH("speech"),
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_SAMPLES = 512
        const val MODEL_FILE = "silero_vad.int8.onnx"
        const val MODEL_SHA256 = "c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20"
    }
}

/** Pure policy so it can be qualified without a device/JNI runtime. */
internal object MainaVoiceActivityPolicy {
    const val SPEECH_THRESHOLD = 0.25f
    const val MIN_SILENCE_SECONDS = 0.5f
    const val MIN_SPEECH_SECONDS = 0.5f
    private const val STRONG_SPEECH_THRESHOLD = 0.55f
    private const val SILENCE_PROBABILITY_CEILING = 0.08f
    private const val FRAME_MS = 32L
    private const val MIN_CONFIRMED_RUN_FRAMES = 8 // 256 ms; must also be strong.
    private const val MIN_CONFIRMED_TOTAL_FRAMES = 16 // 512 ms.

    fun assess(scores: List<Float>): MainaVoiceActivity.Assessment {
        if (scores.isEmpty()) return MainaVoiceActivity.Assessment.silence()
        var maxProbability = 0f
        var voicedFrames = 0
        var run = 0
        var longestRun = 0
        var strongFrames = 0
        scores.forEach { raw ->
            val score = raw.coerceIn(0f, 1f)
            maxProbability = max(maxProbability, score)
            if (score >= SPEECH_THRESHOLD) {
                voicedFrames += 1
                run += 1
                longestRun = max(longestRun, run)
            } else {
                run = 0
            }
            if (score >= STRONG_SPEECH_THRESHOLD) strongFrames += 1
        }
        val confirmed =
            (longestRun >= MIN_CONFIRMED_RUN_FRAMES && maxProbability >= STRONG_SPEECH_THRESHOLD) ||
                (voicedFrames >= MIN_CONFIRMED_TOTAL_FRAMES && strongFrames >= MIN_CONFIRMED_RUN_FRAMES)
        val decision = when {
            confirmed -> MainaVoiceActivity.Decision.SPEECH
            maxProbability < SILENCE_PROBABILITY_CEILING -> MainaVoiceActivity.Decision.SILENCE
            // Anything between clearly silent and confidently speech is fed to
            // Qwen once. This is how a whisper/quiet Hindi word stays safe.
            else -> MainaVoiceActivity.Decision.UNCERTAIN
        }
        return MainaVoiceActivity.Assessment(decision, maxProbability, voicedFrames, longestRun)
    }
}
