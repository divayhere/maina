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
        assertEquals(2, MainaQwenAsrPolicy.inferenceThreads)
    }

    @Test
    fun `reserves a small token margin to checkpoint and split suspicious windows`() {
        assertFalse(MainaQwenAsrPolicy.isTruncationSuspected(123))
        assertTrue(MainaQwenAsrPolicy.isTruncationSuspected(124))
    }

    @Test
    fun `keeps low-level silence out of the speech-like empty retry path`() {
        assertFalse(MainaQwenAsrPolicy.isSpeechExpected(-56.0))
        assertTrue(MainaQwenAsrPolicy.isSpeechExpected(-54.9))
    }
}
