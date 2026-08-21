package com.divay.maina.recorder

import android.content.Context
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineQwen3AsrModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import java.io.File
import java.io.RandomAccessFile
import java.net.URI
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.max

/**
 * Qwen is deliberately a post-capture worker. It never owns the microphone,
 * and loads exactly one recognizer at a time to keep the Pixel thermal/memory
 * budget deterministic.
 */
internal class MainaQwenAsr(private val context: Context) {
    private var recognizer: OfflineRecognizer? = null

    data class ModelStatus(val ready: Boolean, val root: String, val reason: String? = null) {
        fun asMap() = mapOf("ready" to ready, "root" to root, "reason" to reason)
    }

    data class Result(
        val text: String,
        val language: String,
        val processingMs: Long,
        val durationMs: Long,
        val windowStartMs: Long,
        val windowEndMs: Long,
        val rmsDbfs: Double,
        val peakDbfs: Double,
        val speechExpected: Boolean,
        val truncationSuspected: Boolean,
        val tokenCount: Int,
    ) {
        fun asMap() = mapOf(
            "outcome" to if (text.isBlank()) "empty" else "success",
            "text" to text,
            "language" to language,
            "processingMs" to processingMs,
            "durationMs" to durationMs,
            "windowStartMs" to windowStartMs,
            "windowEndMs" to windowEndMs,
            "rmsDbfs" to rmsDbfs,
            "peakDbfs" to peakDbfs,
            "speechExpected" to speechExpected,
            "truncationSuspected" to truncationSuspected,
            "tokenCount" to tokenCount,
            "engineId" to ENGINE_ID,
            "engineVersion" to ENGINE_VERSION,
        )
    }

    fun status(): ModelStatus {
        val root = modelRoot()
        val invalid = REQUIRED_FILES.entries.firstOrNull { (relative, expectedBytes) ->
            val file = File(root, relative)
            !file.isFile || file.length() != expectedBytes
        }
        return if (invalid == null) ModelStatus(true, root.absolutePath)
        else {
            val file = File(root, invalid.key)
            val reason = if (!file.isFile) "Missing model file: ${invalid.key}"
            else "Invalid model file size: ${invalid.key} (${file.length()} != ${invalid.value})"
            ModelStatus(false, root.absolutePath, reason)
        }
    }

    @Synchronized
    fun transcribe(uriOrPath: String, startMs: Long, endMs: Long): Result {
        val model = status()
        check(model.ready) { model.reason ?: "Qwen model pack is unavailable" }
        val wav = readWavWindow(fileFor(uriOrPath), startMs, endMs)
        require(wav.sampleRate == 16_000 && wav.channels == 1 && wav.bitsPerSample == 16) {
            "Qwen accepts Maina 16 kHz mono PCM WAV chunks only"
        }
        val samples = wav.samples
        require(samples.isNotEmpty()) { "ASR window contains no PCM samples" }
        val activeRecognizer = recognizer ?: createRecognizer(model.root).also { recognizer = it }
        val stream = activeRecognizer.createStream()
        try {
            stream.acceptWaveform(samples, wav.sampleRate)
            stream.setOption("max_new_tokens", MAX_NEW_TOKENS.toString())
            val started = System.currentTimeMillis()
            activeRecognizer.decode(stream)
            val result = activeRecognizer.getResult(stream)
            val levels = levels(samples)
            val tokenCount = result.tokens.size
            return Result(
                text = result.text.trim(),
                language = result.lang.orEmpty(),
                processingMs = System.currentTimeMillis() - started,
                durationMs = samples.size * 1000L / wav.sampleRate,
                windowStartMs = wav.windowStartMs,
                windowEndMs = wav.windowEndMs,
                rmsDbfs = levels.first,
                peakDbfs = levels.second,
                speechExpected = levels.first >= SPEECH_EXPECTED_RMS_DBFS,
                truncationSuspected = tokenCount >= MAX_NEW_TOKENS - TOKEN_TRUNCATION_MARGIN,
                tokenCount = tokenCount,
            )
        } catch (cause: Throwable) {
            release()
            throw cause
        } finally {
            stream.release()
        }
    }

    @Synchronized
    fun release() {
        runCatching { recognizer?.release() }
        recognizer = null
    }

    private fun createRecognizer(modelRoot: String): OfflineRecognizer {
        val qwen = OfflineQwen3AsrModelConfig().apply {
            convFrontend = File(modelRoot, "conv_frontend.onnx").absolutePath
            encoder = File(modelRoot, "encoder.int8.onnx").absolutePath
            decoder = File(modelRoot, "decoder.int8.onnx").absolutePath
            tokenizer = File(modelRoot, "tokenizer").absolutePath
            maxTotalLen = MAX_TOTAL_LEN
            maxNewTokens = MAX_NEW_TOKENS
        }
        val modelConfig = OfflineModelConfig().apply {
            qwen3Asr = qwen
            tokens = ""
            numThreads = 4
            debug = false
            provider = "cpu"
        }
        val config = OfflineRecognizerConfig().apply {
            this.modelConfig = modelConfig
            decodingMethod = "greedy_search"
        }
        // The model pack is downloaded into app storage, not bundled in the
        // APK. sherpa-onnx selects newFromFile only when AssetManager is null.
        return OfflineRecognizer(config = config)
    }

    private fun modelRoot(): File {
        val candidates = listOfNotNull(
            context.getExternalFilesDir(null)?.let { File(it, "models/qwen3-asr-0.6b-int8") },
            File(context.filesDir, "models/qwen3-asr-0.6b-int8"),
        )
        return candidates.firstOrNull { root -> REQUIRED_FILES.keys.all { relative -> File(root, relative).isFile } }
            ?: candidates.first()
    }

    private fun fileFor(uriOrPath: String): File = if (uriOrPath.startsWith("file:")) File(URI(uriOrPath)) else File(uriOrPath)

    private fun readWavWindow(file: File, requestedStartMs: Long, requestedEndMs: Long): Wav {
        require(file.isFile) { "Audio window does not exist" }
        RandomAccessFile(file, "r").use { input ->
            val header = ByteArray(44)
            input.readFully(header)
            require(String(header, 0, 4, Charsets.US_ASCII) == "RIFF") { "Not a WAV file" }
            require(String(header, 8, 4, Charsets.US_ASCII) == "WAVE") { "Not a WAV file" }
            val channels = leShort(header, 22)
            val sampleRate = leInt(header, 24)
            val bits = leShort(header, 34)
            val dataSize = leInt(header, 40)
            require(dataSize >= 0 && dataSize <= file.length() - 44) { "Invalid WAV data length" }
            val totalSamples = dataSize / 2
            val totalDurationMs = totalSamples * 1000L / sampleRate
            val startMs = requestedStartMs.coerceIn(0L, totalDurationMs)
            val endMs = requestedEndMs.coerceIn(startMs + 1L, totalDurationMs.coerceAtLeast(startMs + 1L))
            val startSample = (startMs * sampleRate / 1000L).coerceAtMost(totalSamples.toLong()).toInt()
            val endSample = (endMs * sampleRate / 1000L).coerceAtMost(totalSamples.toLong()).toInt()
            val sampleCount = (endSample - startSample).coerceAtLeast(0)
            val bytes = ByteArray(sampleCount * 2)
            input.seek(44L + startSample * 2L)
            input.readFully(bytes)
            val samples = FloatArray(bytes.size / 2)
            for (index in samples.indices) {
                val low = bytes[index * 2].toInt() and 0xff
                val high = bytes[index * 2 + 1].toInt()
                samples[index] = ((high shl 8) or low).toShort() / 32768f
            }
            return Wav(
                sampleRate = sampleRate,
                channels = channels,
                bitsPerSample = bits,
                samples = samples,
                windowStartMs = startSample * 1000L / sampleRate,
                windowEndMs = endSample * 1000L / sampleRate,
            )
        }
    }

    private fun levels(samples: FloatArray): Pair<Double, Double> {
        var sumSquares = 0.0
        var peak = 0.0
        samples.forEach { sample ->
            val value = sample.toDouble()
            sumSquares += value * value
            peak = max(peak, abs(value))
        }
        val rms = kotlin.math.sqrt(sumSquares / samples.size.coerceAtLeast(1))
        return dbfs(rms) to dbfs(peak)
    }

    private fun dbfs(value: Double): Double = 20.0 * log10(value.coerceAtLeast(1e-9))

    private fun leInt(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)

    private fun leShort(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xff) or ((bytes[offset + 1].toInt() and 0xff) shl 8)

    private data class Wav(
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val samples: FloatArray,
        val windowStartMs: Long,
        val windowEndMs: Long,
    )

    private companion object {
        const val ENGINE_ID = "qwen3-0.6b-int8"
        const val ENGINE_VERSION = "sherpa-onnx-1.13.6"
        const val MAX_TOTAL_LEN = 1024
        const val MAX_NEW_TOKENS = 256
        const val TOKEN_TRUNCATION_MARGIN = 4
        const val SPEECH_EXPECTED_RMS_DBFS = -55.0
        val REQUIRED_FILES = linkedMapOf(
            "conv_frontend.onnx" to 44_148_281L,
            "encoder.int8.onnx" to 182_491_662L,
            "decoder.int8.onnx" to 755_914_231L,
            "tokenizer/vocab.json" to 2_776_833L,
            "tokenizer/merges.txt" to 1_671_853L,
            "tokenizer/tokenizer_config.json" to 12_487L,
        )
    }
}
