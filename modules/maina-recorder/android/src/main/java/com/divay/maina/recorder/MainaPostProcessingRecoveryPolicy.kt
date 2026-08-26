package com.divay.maina.recorder

/**
 * Bounded autonomous recovery policy. It deliberately stops before an
 * undiagnosed malformed file can keep a phone hot forever. A later foreground
 * launch can still make another safe attempt from the durable window manifest.
 */
internal object MainaPostProcessingRecoveryPolicy {
    const val IMMEDIATE_SERVICE_RETRY_PASSES = 1
    const val MAX_SCHEDULED_RECOVERY_ROUNDS = 4
    private const val IMMEDIATE_RETRY_DELAY_MS = 1_500L

    fun shouldRunImmediateRetry(completed: Boolean, completedPasses: Int): Boolean =
        !completed && completedPasses < IMMEDIATE_SERVICE_RETRY_PASSES

    fun immediateRetryDelayMs(): Long = IMMEDIATE_RETRY_DELAY_MS

    fun shouldScheduleAnotherRound(recoveryRounds: Int): Boolean =
        recoveryRounds < MAX_SCHEDULED_RECOVERY_ROUNDS
}
