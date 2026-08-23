package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Test

class MainaPostProcessingSupportTest {
    @Test
    fun `short audio produces one complete window`() {
        assertEquals(
            listOf(AsrWindow(startMs = 0L, endMs = 12_000L)),
            MainaPostProcessingSupport.planWindows(12_000L),
        )
    }

    @Test
    fun `long audio uses overlap without a tiny tail`() {
        assertEquals(
            listOf(
                AsrWindow(startMs = 0L, endMs = 15_000L),
                AsrWindow(startMs = 13_000L, endMs = 28_000L),
                AsrWindow(startMs = 26_000L, endMs = 40_000L),
            ),
            MainaPostProcessingSupport.planWindows(40_000L),
        )
    }

    @Test
    fun `exact overlap is removed but new speech remains`() {
        assertEquals(
            "and this part is new",
            MainaPostProcessingSupport.removeExactOverlap(
                "we agreed to ship the reliable recorder",
                "the reliable recorder and this part is new",
            ),
        )
    }

    @Test
    fun `non matching bilingual text remains untouched`() {
        assertEquals(
            "अब English section starts",
            MainaPostProcessingSupport.removeExactOverlap(
                "यह Hindi वाला हिस्सा है",
                "अब English section starts",
            ),
        )
    }

    @Test
    fun `suspicious window splits into two bounded overlapping retries`() {
        assertEquals(
            listOf(
                AsrWindow(startMs = 1_000L, endMs = 9_000L),
                AsrWindow(startMs = 8_000L, endMs = 16_000L),
            ),
            MainaPostProcessingSupport.splitForRetry(
                AsrWindow(startMs = 1_000L, endMs = 16_000L),
            ),
        )
    }

    @Test
    fun `short suspicious window is not recursively split`() {
        assertEquals(
            emptyList<AsrWindow>(),
            MainaPostProcessingSupport.splitForRetry(
                AsrWindow(startMs = 0L, endMs = 5_999L),
            ),
        )
    }

    @Test
    fun `coverage requires every window and no failures`() {
        assertEquals(true, MainaPostProcessingSupport.coverageComplete(216, 216, 0))
        assertEquals(false, MainaPostProcessingSupport.coverageComplete(216, 190, 26))
        assertEquals(false, MainaPostProcessingSupport.coverageComplete(0, 0, 0))
    }
}
