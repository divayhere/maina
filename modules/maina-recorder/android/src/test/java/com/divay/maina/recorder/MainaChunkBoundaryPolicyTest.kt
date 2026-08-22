package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Test

class MainaChunkBoundaryPolicyTest {
    @Test
    fun `pause advances to a new chunk when audio already exists`() {
        assertEquals(
            4,
            MainaChunkBoundaryPolicy.nextChunkIndex(3, hadActiveChunk = true, MainaChunkBoundaryPolicy.BoundaryReason.PAUSE),
        )
    }

    @Test
    fun `stop does not create an unused trailing chunk`() {
        assertEquals(
            3,
            MainaChunkBoundaryPolicy.nextChunkIndex(3, hadActiveChunk = true, MainaChunkBoundaryPolicy.BoundaryReason.STOP),
        )
    }

    @Test
    fun `empty boundary does not advance the chunk cursor`() {
        assertEquals(
            3,
            MainaChunkBoundaryPolicy.nextChunkIndex(3, hadActiveChunk = false, MainaChunkBoundaryPolicy.BoundaryReason.ROUTE_CHANGE),
        )
    }
}
