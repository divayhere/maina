package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MainaPostProcessingStartPolicyTest {
    @Test
    fun `meeting lookup retries are bounded and back off`() {
        assertEquals(7, MainaPostProcessingStartPolicy.meetingLookupAttempts())
        assertEquals(150L, MainaPostProcessingStartPolicy.meetingLookupDelayMs(0))
        assertEquals(300L, MainaPostProcessingStartPolicy.meetingLookupDelayMs(1))
        assertEquals(2_500L, MainaPostProcessingStartPolicy.meetingLookupDelayMs(5))
        assertEquals(2_500L, MainaPostProcessingStartPolicy.meetingLookupDelayMs(99))
    }

    @Test
    fun `finalized chunk retries are shorter and bounded`() {
        assertEquals(5, MainaPostProcessingStartPolicy.finalizedChunkAttempts())
        assertEquals(150L, MainaPostProcessingStartPolicy.finalizedChunkDelayMs(0))
        assertEquals(1_000L, MainaPostProcessingStartPolicy.finalizedChunkDelayMs(3))
        assertEquals(1_000L, MainaPostProcessingStartPolicy.finalizedChunkDelayMs(99))
        assertTrue(
            MainaPostProcessingStartPolicy.meetingLookupDelayMs(5) >
                MainaPostProcessingStartPolicy.finalizedChunkDelayMs(3),
        )
    }
}
