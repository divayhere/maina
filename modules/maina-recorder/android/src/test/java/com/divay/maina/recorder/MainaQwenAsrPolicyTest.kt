package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaQwenAsrPolicyTest {
    @Test
    fun `uses the bounded Qwen configuration qualified for the Pixel`() {
        assertEquals(512, MainaQwenAsrPolicy.maxTotalLen)
        assertEquals(128, MainaQwenAsrPolicy.maxNewTokens)
        assertEquals(256, MainaQwenAsrPolicy.recoveryMaxNewTokens)
        assertEquals(2, MainaQwenAsrPolicy.inferenceThreads)
    }

    @Test
    fun `only treats an exact output cap as a token truncation`() {
        assertFalse(MainaQwenAsrPolicy.isTruncationSuspected(127, 128))
        assertTrue(MainaQwenAsrPolicy.isTruncationSuspected(128, 128))
        assertFalse(MainaQwenAsrPolicy.isTruncationSuspected(255, 256))
        assertTrue(MainaQwenAsrPolicy.isTruncationSuspected(256, 256))
    }

    @Test
    fun `allows exactly one bounded output expansion`() {
        assertTrue(MainaQwenAsrPolicy.canUseRecoveryBudget(128))
        assertFalse(MainaQwenAsrPolicy.canUseRecoveryBudget(256))
    }

    @Test
    fun `keeps low-level silence out of the speech-like empty retry path`() {
        assertFalse(MainaQwenAsrPolicy.isSpeechExpected(-56.0))
        assertTrue(MainaQwenAsrPolicy.isSpeechExpected(-54.9))
    }
}
