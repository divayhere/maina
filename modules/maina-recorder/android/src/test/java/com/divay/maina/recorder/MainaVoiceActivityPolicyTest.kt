package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaVoiceActivityPolicyTest {
    @Test
    fun `digital silence is skipped without invoking ASR`() {
        val assessment = MainaVoiceActivityPolicy.assess(List(40) { 0.01f })

        assertEquals(MainaVoiceActivity.Decision.SILENCE, assessment.decision)
        assertFalse(assessment.shouldTranscribe)
        assertFalse(assessment.requiresRecoveryAfterBlank)
    }

    @Test
    fun `brief or quiet evidence stays uncertain and gets one ASR attempt`() {
        val assessment = MainaVoiceActivityPolicy.assess(
            listOf(0.03f, 0.18f, 0.31f, 0.29f, 0.14f, 0.04f),
        )

        assertEquals(MainaVoiceActivity.Decision.UNCERTAIN, assessment.decision)
        assertTrue(assessment.shouldTranscribe)
        assertFalse(assessment.requiresRecoveryAfterBlank)
    }

    @Test
    fun `sustained confident voice is recoverable if Qwen returns blank`() {
        val assessment = MainaVoiceActivityPolicy.assess(List(20) { 0.82f })

        assertEquals(MainaVoiceActivity.Decision.SPEECH, assessment.decision)
        assertTrue(assessment.shouldTranscribe)
        assertTrue(assessment.requiresRecoveryAfterBlank)
        assertTrue(assessment.speechMs >= 500L)
    }

    @Test
    fun `sporadic room noise cannot become confirmed speech`() {
        val assessment = MainaVoiceActivityPolicy.assess(
            List(20) { index -> if (index % 2 == 0) 0.72f else 0.03f },
        )

        assertEquals(MainaVoiceActivity.Decision.UNCERTAIN, assessment.decision)
        assertTrue(assessment.shouldTranscribe)
        assertFalse(assessment.requiresRecoveryAfterBlank)
    }
}
