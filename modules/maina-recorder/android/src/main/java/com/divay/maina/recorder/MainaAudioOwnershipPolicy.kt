package com.divay.maina.recorder

internal enum class MainaAudioOwnershipPhase {
    PAUSED,
    INTENT_DURABLE,
    CHUNK_DURABLE,
    AUDIO_OWNED,
    RECORDING_PUBLISHED,
}

/**
 * Pure ordering guard for initial and resumed AudioRecord ownership.
 * A durable empty WAV/journal identity must exist before Android may acquire
 * the microphone, and UI state may be published only after ownership succeeds.
 */
internal object MainaAudioOwnershipPolicy {
    fun afterIntent(from: MainaAudioOwnershipPhase): MainaAudioOwnershipPhase {
        check(from == MainaAudioOwnershipPhase.PAUSED)
        return MainaAudioOwnershipPhase.INTENT_DURABLE
    }

    fun afterChunkPrepared(from: MainaAudioOwnershipPhase): MainaAudioOwnershipPhase {
        check(from == MainaAudioOwnershipPhase.INTENT_DURABLE)
        return MainaAudioOwnershipPhase.CHUNK_DURABLE
    }

    fun afterAudioOwned(from: MainaAudioOwnershipPhase): MainaAudioOwnershipPhase {
        check(from == MainaAudioOwnershipPhase.CHUNK_DURABLE)
        return MainaAudioOwnershipPhase.AUDIO_OWNED
    }

    fun afterPublished(from: MainaAudioOwnershipPhase): MainaAudioOwnershipPhase {
        check(from == MainaAudioOwnershipPhase.AUDIO_OWNED)
        return MainaAudioOwnershipPhase.RECORDING_PUBLISHED
    }

    fun afterStartFailure(from: MainaAudioOwnershipPhase): MainaAudioOwnershipPhase {
        check(from == MainaAudioOwnershipPhase.CHUNK_DURABLE)
        return MainaAudioOwnershipPhase.PAUSED
    }
}
