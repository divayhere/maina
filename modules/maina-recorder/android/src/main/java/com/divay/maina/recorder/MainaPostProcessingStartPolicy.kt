package com.divay.maina.recorder

internal object MainaPostProcessingStartPolicy {
    private val meetingLookupDelaysMs = listOf(150L, 300L, 600L, 1_000L, 1_500L, 2_500L)
    private val finalizedChunkDelaysMs = listOf(150L, 300L, 600L, 1_000L)

    fun meetingLookupAttempts(): Int = meetingLookupDelaysMs.size + 1

    fun meetingLookupDelayMs(attempt: Int): Long =
        meetingLookupDelaysMs.getOrElse(attempt) { meetingLookupDelaysMs.last() }

    fun finalizedChunkAttempts(): Int = finalizedChunkDelaysMs.size + 1

    fun finalizedChunkDelayMs(attempt: Int): Long =
        finalizedChunkDelaysMs.getOrElse(attempt) { finalizedChunkDelaysMs.last() }
}
