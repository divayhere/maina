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
        assertTrue(MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(3))
        assertFalse(MainaPostProcessingRecoveryPolicy.shouldScheduleAnotherRound(4))
    }
}
