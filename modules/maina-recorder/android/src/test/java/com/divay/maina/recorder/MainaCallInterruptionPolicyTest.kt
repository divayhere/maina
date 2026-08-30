package com.divay.maina.recorder

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaCallInterruptionPolicyTest {
    @Test
    fun `communication and call modes pause active capture`() {
        assertTrue(MainaCallInterruptionPolicy.communicationActive(2, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(3, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(6, false))
        assertTrue(MainaCallInterruptionPolicy.communicationActive(0, true))
        assertFalse(MainaCallInterruptionPolicy.communicationActive(0, false))
    }

    @Test
    fun `only automatic call pauses are automatically resumed`() {
        assertTrue(MainaCallInterruptionPolicy.shouldPause("recording", false, true))
        assertFalse(MainaCallInterruptionPolicy.shouldPause("paused", false, true))
        assertTrue(MainaCallInterruptionPolicy.shouldResume("paused", true, false))
        assertFalse(MainaCallInterruptionPolicy.shouldResume("recording", true, false))
        assertFalse(MainaCallInterruptionPolicy.shouldResume("paused", false, false))
    }

    @Test
    fun `resume retries are bounded and begin after stable normal audio mode`() {
        assertTrue(MainaCallInterruptionPolicy.resumeRetryDelayMs(0) >= 750L)
        assertTrue(MainaCallInterruptionPolicy.resumeRetryDelayMs(4) <= 5_000L)
    }
}
