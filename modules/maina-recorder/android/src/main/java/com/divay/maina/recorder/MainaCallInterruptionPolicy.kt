package com.divay.maina.recorder

internal object MainaCallInterruptionPolicy {
    const val MODE_IN_CALL = 2
    const val MODE_IN_COMMUNICATION = 3
    const val MODE_CALL_SCREENING = 4
    const val MODE_CALL_REDIRECT = 5
    const val MODE_COMMUNICATION_REDIRECT = 6
    const val STABLE_NORMAL_MS = 750L
    const val RESUME_RETRY_BUDGET_MS = 30_000L

    fun communicationActive(audioMode: Int, clientSilenced: Boolean): Boolean =
        clientSilenced || audioMode in setOf(
            MODE_IN_CALL,
            MODE_IN_COMMUNICATION,
            MODE_CALL_SCREENING,
            MODE_CALL_REDIRECT,
            MODE_COMMUNICATION_REDIRECT,
        )

    fun shouldPause(captureState: String, alreadyPausedForCall: Boolean, communicationActive: Boolean): Boolean =
        captureState == "recording" && !alreadyPausedForCall && communicationActive

    fun shouldResume(captureState: String, pausedForCall: Boolean, communicationActive: Boolean): Boolean =
        captureState in setOf("pausing", "paused") && pausedForCall && !communicationActive

    fun resumeRetryDelayMs(attempt: Int): Long = when (attempt.coerceAtLeast(0)) {
        0 -> STABLE_NORMAL_MS
        1 -> 1_500L
        2 -> 3_000L
        else -> 5_000L
    }
}
