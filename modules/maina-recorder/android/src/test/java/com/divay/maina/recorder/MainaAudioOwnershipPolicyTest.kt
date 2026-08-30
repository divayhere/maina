package com.divay.maina.recorder

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class MainaAudioOwnershipPolicyTest {
    @Test
    fun `resume cannot acquire audio before its chunk identity is durable`() {
        val intent = MainaAudioOwnershipPolicy.afterIntent(MainaAudioOwnershipPhase.PAUSED)
        assertThrows(IllegalStateException::class.java) {
            MainaAudioOwnershipPolicy.afterAudioOwned(intent)
        }
        val chunk = MainaAudioOwnershipPolicy.afterChunkPrepared(intent)
        assertEquals(MainaAudioOwnershipPhase.AUDIO_OWNED, MainaAudioOwnershipPolicy.afterAudioOwned(chunk))
    }

    @Test
    fun `recording cannot publish before audio ownership succeeds`() {
        val intent = MainaAudioOwnershipPolicy.afterIntent(MainaAudioOwnershipPhase.PAUSED)
        val chunk = MainaAudioOwnershipPolicy.afterChunkPrepared(intent)
        assertThrows(IllegalStateException::class.java) {
            MainaAudioOwnershipPolicy.afterPublished(chunk)
        }
    }

    @Test
    fun `failed ownership returns to paused and keeps generation retryable`() {
        val intent = MainaAudioOwnershipPolicy.afterIntent(MainaAudioOwnershipPhase.PAUSED)
        val chunk = MainaAudioOwnershipPolicy.afterChunkPrepared(intent)
        assertEquals(MainaAudioOwnershipPhase.PAUSED, MainaAudioOwnershipPolicy.afterStartFailure(chunk))
    }

    @Test
    fun `successful sequence publishes only after all durable boundaries`() {
        val intent = MainaAudioOwnershipPolicy.afterIntent(MainaAudioOwnershipPhase.PAUSED)
        val chunk = MainaAudioOwnershipPolicy.afterChunkPrepared(intent)
        val owned = MainaAudioOwnershipPolicy.afterAudioOwned(chunk)
        assertEquals(
            MainaAudioOwnershipPhase.RECORDING_PUBLISHED,
            MainaAudioOwnershipPolicy.afterPublished(owned),
        )
    }
}
