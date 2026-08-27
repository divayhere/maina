package com.divay.maina.recorder

/**
 * Bounded autonomous recovery policy. It deliberately stops before an
 * undiagnosed malformed file can keep a phone hot forever. A later foreground
 * launch can still make another safe attempt from the durable window manifest.
 */
internal object MainaPostProcessingRecoveryPolicy {
    const val IMMEDIATE_SERVICE_RETRY_PASSES = 1
    const val MAX_SCHEDULED_RECOVERY_ROUNDS = 3
    private const val IMMEDIATE_RETRY_DELAY_MS = 1_500L
    private const val FIRST_DELAYED_RETRY_MS = 20L * 60L * 1_000L
    private const val SECOND_DELAYED_RETRY_MS = 60L * 60L * 1_000L

    fun shouldRunImmediateRetry(completed: Boolean, completedPasses: Int): Boolean =
        !completed && completedPasses < IMMEDIATE_SERVICE_RETRY_PASSES

    fun immediateRetryDelayMs(): Long = IMMEDIATE_RETRY_DELAY_MS

    fun shouldScheduleAnotherRound(recoveryRounds: Int): Boolean =
        recoveryRounds < MAX_SCHEDULED_RECOVERY_ROUNDS

    fun scheduledRetryDelayMs(recoveryRounds: Int): Long = when {
        recoveryRounds <= 0 -> 0L
        recoveryRounds == 1 -> FIRST_DELAYED_RETRY_MS
        else -> SECOND_DELAYED_RETRY_MS
    }

    fun uniqueWorkName(meetingId: String, recoveryRounds: Int): String =
        "maina-asr-recovery-$meetingId-round-${recoveryRounds.coerceAtLeast(0)}"

    fun isCurrentScheduledRound(scheduledRecoveryRound: Int, currentRecoveryRounds: Int): Boolean =
        scheduledRecoveryRound == currentRecoveryRounds
}
