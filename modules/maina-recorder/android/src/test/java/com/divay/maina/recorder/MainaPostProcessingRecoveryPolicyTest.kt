package com.divay.maina.recorder

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaPostProcessingRecoveryPolicyTest {
    @Test
    fun `runs one immediate retry but never loops the active service forever`() {
        assertTrue(MainaPostProcessingRecoveryPolicy.shouldRunImmediateRetry(false, 0))
        assertFalse(MainaPostProcessingRecoveryPolicy.shouldRunImmediateRetry(false, 1))
        assertFalse(MainaPostProcessingRecoveryPolicy.shouldRunImmediateRetry(true, 0))
    }

    @Test
    fun `caps scheduled recovery rounds`() {
        assertTrue(MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(0))
        assertTrue(MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(2))
        assertFalse(MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(3))
    }

    @Test
    fun `uses a distinct work name per recovery round`() {
        assertTrue(MainaPostProcessingRecoveryPolicy.uniqueWorkName("meeting", 1).endsWith("round-1"))
        assertTrue(MainaPostProcessingRecoveryPolicy.uniqueWorkName("meeting", 2).endsWith("round-2"))
        assertFalse(
            MainaPostProcessingRecoveryPolicy.uniqueWorkName("meeting", 1) ==
                MainaPostProcessingRecoveryPolicy.uniqueWorkName("meeting", 2),
        )
    }

    @Test
    fun `rejects a stale delayed worker after foreground recovery advances the round`() {
        assertTrue(MainaPostProcessingRecoveryPolicy.isCurrentScheduledRound(2, 2))
        assertFalse(MainaPostProcessingRecoveryPolicy.isCurrentScheduledRound(1, 2))
        assertFalse(MainaPostProcessingRecoveryPolicy.isCurrentScheduledRound(2, 3))
    }

    @Test
    fun `spaces delayed retries without delaying deferred first starts`() {
        assertTrue(MainaPostProcessingRecoveryPolicy.scheduledRetryDelayMs(0) == 0L)
        assertTrue(MainaPostProcessingRecoveryPolicy.scheduledRetryDelayMs(1) == 20L * 60L * 1_000L)
        assertTrue(MainaPostProcessingRecoveryPolicy.scheduledRetryDelayMs(2) == 60L * 60L * 1_000L)
    }
}
