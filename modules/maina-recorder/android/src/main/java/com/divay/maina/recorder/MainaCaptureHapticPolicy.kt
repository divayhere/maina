package com.divay.maina.recorder

/**
 * Pocket-readable patterns for *confirmed* capture state changes. The service
 * never vibrates for a requested command; it only calls this after native audio
 * has reached the new state.
 */
internal object MainaCaptureHapticPolicy {
    fun waveform(previous: String, next: String): LongArray? = when {
        previous == "idle" && next == "recording" -> longArrayOf(0, 55, 45, 125)
        previous == "recording" && next == "paused" -> longArrayOf(0, 65, 70, 65)
        previous == "paused" && next == "recording" -> longArrayOf(0, 45, 45, 45, 45, 45)
        previous == "finalizing" && next == "idle" -> longArrayOf(0, 45, 45, 45, 45, 150)
        else -> null
    }

    fun amplitudes(waveform: LongArray): IntArray = IntArray(waveform.size) { index ->
        if (index % 2 == 0) 0 else 180
    }
}
