package com.divay.maina.recorder

internal object MainaChunkBoundaryPolicy {
    enum class BoundaryReason {
        PAUSE,
        ROUTE_CHANGE,
        ROTATION,
        READ_RECOVERY,
        STOP,
    }

    fun nextChunkIndex(currentChunkIndex: Int, hadActiveChunk: Boolean, reason: BoundaryReason): Int {
        if (!hadActiveChunk) return currentChunkIndex
        return when (reason) {
            BoundaryReason.STOP -> currentChunkIndex
            BoundaryReason.PAUSE,
            BoundaryReason.ROUTE_CHANGE,
            BoundaryReason.ROTATION,
            BoundaryReason.READ_RECOVERY,
            -> currentChunkIndex + 1
        }
    }
}
