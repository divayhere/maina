package com.divay.maina.recorder

import java.io.File
import java.io.RandomAccessFile
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal data class AsrWindow(
    val startMs: Long,
    val endMs: Long,
)

internal object MainaPostProcessingSupport {
    private const val DEFAULT_WINDOW_MS = 15_000L
    private const val DEFAULT_OVERLAP_MS = 2_000L
    private const val MIN_TAIL_MS = 5_000L
    private const val RETRY_MIN_WINDOW_MS = 6_000L
    private const val RETRY_OVERLAP_MS = 1_000L

    fun planWindows(durationMs: Long): List<AsrWindow> {
        if (durationMs <= 0L) return emptyList()
        val roundedDuration = ceil(durationMs.toDouble()).toLong()
        val windows = mutableListOf<AsrWindow>()
        var startMs = 0L
        while (startMs < roundedDuration) {
            var endMs = min(roundedDuration, startMs + DEFAULT_WINDOW_MS)
            if (roundedDuration - endMs <= MIN_TAIL_MS) endMs = roundedDuration
            windows += AsrWindow(startMs = startMs, endMs = endMs)
            if (endMs >= roundedDuration) break
            startMs = endMs - DEFAULT_OVERLAP_MS
        }
        return windows
    }

    fun removeExactOverlap(previous: String, current: String, maxWords: Int = 24): String {
        val previousWords = previous.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        val currentWords = current.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        val limit = min(maxWords, min(previousWords.size, currentWords.size))
        for (count in limit downTo 2) {
            val tail = previousWords.takeLast(count).map(::normalizeToken)
            val head = currentWords.take(count).map(::normalizeToken)
            if (tail.indices.all { index -> tail[index].isNotEmpty() && tail[index] == head[index] }) {
                return currentWords.drop(count).joinToString(" ").trim()
            }
        }
        return current.trim()
    }

    /**
     * A token-capped or speech-like empty window gets one bounded recovery
     * pass as two shorter overlapping windows. We never respond by increasing
     * Qwen's token/KV-cache limits.
     */
    fun splitForRetry(window: AsrWindow): List<AsrWindow> {
        val duration = window.endMs - window.startMs
        if (duration < RETRY_MIN_WINDOW_MS) return emptyList()
        val midpoint = window.startMs + duration / 2L
        val halfOverlap = RETRY_OVERLAP_MS / 2L
        return listOf(
            AsrWindow(window.startMs, min(window.endMs, midpoint + halfOverlap)),
            AsrWindow(max(window.startMs, midpoint - halfOverlap), window.endMs),
        ).filter { it.endMs > it.startMs }
    }

    fun coverageComplete(totalWindows: Int, completedWindows: Int, failedWindows: Int): Boolean =
        totalWindows > 0 && failedWindows == 0 && completedWindows == totalWindows

    fun durationMs(uriOrPath: String): Long {
        val file = if (uriOrPath.startsWith("file:")) File(java.net.URI(uriOrPath)) else File(uriOrPath)
        if (!file.isFile || file.length() <= MainaNativeAudioCapture.WAV_HEADER_BYTES) return 0L
        RandomAccessFile(file, "r").use { input ->
            val header = ByteArray(44)
            input.readFully(header)
            val sampleRate = leInt(header, 24)
            if (sampleRate <= 0L) return 0L
            val bytes = max(0L, file.length() - MainaNativeAudioCapture.WAV_HEADER_BYTES)
            return bytes * 1000L / (sampleRate * MainaNativeAudioCapture.BYTES_PER_FRAME)
        }
    }

    private fun normalizeToken(value: String): String = value
        .lowercase()
        .replace(Regex("[^\\p{L}\\p{N}]+"), "")

    private fun leInt(bytes: ByteArray, offset: Int): Long =
        ((bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)).toLong()
}
