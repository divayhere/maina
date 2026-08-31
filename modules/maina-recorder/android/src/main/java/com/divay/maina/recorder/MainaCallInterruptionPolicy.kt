package com.divay.maina.recorder

import android.media.AudioManager

internal enum class MainaCapturePauseOwner { NONE, MANUAL, SYSTEM }
internal enum class MainaCaptureControlPhase {
    IDLE, RECORDING, PAUSE_PENDING, PAUSED, RESUME_PENDING, TERMINAL,
}

internal data class MainaCaptureControlState(
    val phase: MainaCaptureControlPhase = MainaCaptureControlPhase.IDLE,
    val pauseOwner: MainaCapturePauseOwner = MainaCapturePauseOwner.NONE,
    val generation: Long = 0L,
    val communicationActive: Boolean = false,
)

internal sealed interface MainaCaptureControlDecision {
    data class Pause(val state: MainaCaptureControlState) : MainaCaptureControlDecision
    data class Resume(val state: MainaCaptureControlState) : MainaCaptureControlDecision
    data class StateOnly(val state: MainaCaptureControlState) : MainaCaptureControlDecision
    data class Denied(val state: MainaCaptureControlState) : MainaCaptureControlDecision
}

internal enum class MainaCaptureOperationKind { START, PAUSE, RESUME, STOP, ABORT }

/**
 * Immutable authority issued by the service main looper before native work is queued.
 * The reducer may observe a communication transition while an operation is running,
 * so [generation] describes the exact state that issued the operation; freshness is
 * decided by equality with the main-looper-owned active token plus phase/owner truth.
 */
internal data class MainaCaptureOperationToken(
    val operationId: Long,
    val generation: Long,
    val owner: MainaCapturePauseOwner,
    val kind: MainaCaptureOperationKind,
    val expectedPhase: MainaCaptureControlPhase,
    val captureSessionId: String? = null,
    val expectedPrivacyLatchGeneration: Long? = null,
)

internal object MainaCaptureOperationPolicy {
    fun nativePreparationAllowed(
        latestOperationId: Long,
        operation: MainaCaptureOperationToken,
        currentPrivacyLatchGeneration: Long,
        communicationActive: Boolean,
        acceptingWork: Boolean,
    ): Boolean = acceptingWork &&
        operation.kind in setOf(MainaCaptureOperationKind.START, MainaCaptureOperationKind.RESUME) &&
        operation.operationId == latestOperationId &&
        operation.expectedPrivacyLatchGeneration != null &&
        operation.expectedPrivacyLatchGeneration == currentPrivacyLatchGeneration &&
        !communicationActive

    fun startAdmissionAllowed(
        state: MainaCaptureControlState,
        captureUiState: String,
        operationActive: Boolean,
    ): Boolean = !operationActive && when (state.phase) {
        MainaCaptureControlPhase.IDLE -> captureUiState == "idle"
        MainaCaptureControlPhase.TERMINAL -> captureUiState == "idle"
        else -> false
    }

    fun preparationFailureNeedsPause(kind: MainaCaptureOperationKind): Boolean =
        kind == MainaCaptureOperationKind.RESUME

    fun startFailureMustTerminalize(
        kind: MainaCaptureOperationKind,
        state: MainaCaptureControlState,
        acceptingWork: Boolean,
        completionSessionId: String?,
        currentSessionId: String?,
    ): Boolean = acceptingWork &&
        kind == MainaCaptureOperationKind.START &&
        state.phase != MainaCaptureControlPhase.TERMINAL &&
        completionSessionId != null &&
        completionSessionId == currentSessionId

    fun pauseFailureMustTerminalize(
        state: MainaCaptureControlState,
        acceptingWork: Boolean,
    ): Boolean = acceptingWork && state.phase != MainaCaptureControlPhase.TERMINAL

    fun accepts(
        active: MainaCaptureOperationToken?,
        completion: MainaCaptureOperationToken,
        state: MainaCaptureControlState,
        acceptingWork: Boolean = true,
    ): Boolean {
        if (!acceptingWork) return false
        if (active != completion) return false
        if (completion.kind == MainaCaptureOperationKind.STOP ||
            completion.kind == MainaCaptureOperationKind.ABORT
        ) {
            return state.phase == MainaCaptureControlPhase.TERMINAL
        }
        return state.phase != MainaCaptureControlPhase.TERMINAL &&
            state.phase == completion.expectedPhase &&
            state.pauseOwner == completion.owner &&
            state.generation >= completion.generation
    }

    fun publicationAllowed(
        active: MainaCaptureOperationToken?,
        completion: MainaCaptureOperationToken,
        state: MainaCaptureControlState,
        communicationActive: Boolean,
        acceptingWork: Boolean = true,
    ): Boolean = completion.kind in setOf(
        MainaCaptureOperationKind.START,
        MainaCaptureOperationKind.RESUME,
    ) && accepts(active, completion, state, acceptingWork) && !communicationActive

    fun enableAllowed(
        active: MainaCaptureOperationToken?,
        completion: MainaCaptureOperationToken,
        state: MainaCaptureControlState,
        communicationActive: Boolean,
        acceptingWork: Boolean,
    ): Boolean = acceptingWork && active == completion &&
        completion.kind in setOf(MainaCaptureOperationKind.START, MainaCaptureOperationKind.RESUME) &&
        state.phase == MainaCaptureControlPhase.RECORDING &&
        state.pauseOwner == MainaCapturePauseOwner.NONE &&
        !communicationActive
}

/**
 * Pure ordering seam used by the service for privacy-critical transitions.
 * Native reads are latched off before state/durability work, and the serialized
 * native cleanup is queued even when persistence throws.
 */
internal object MainaCaptureSafetySequencer {
    fun latchApplyPersistThenQueue(
        latch: () -> Unit,
        apply: () -> Unit,
        persist: () -> Unit,
        queue: () -> Unit,
    ): Throwable? {
        latch()
        apply()
        var failure: Throwable? = null
        try {
            persist()
        } catch (cause: Throwable) {
            failure = cause
        } finally {
            queue()
        }
        return failure
    }
}

internal object MainaCaptureLifecyclePolicy {
    fun acceptsNativeWork(acceptingWork: Boolean, destroyed: Boolean): Boolean =
        acceptingWork && !destroyed

    fun shouldQueueDestroyStop(alreadyQueued: Boolean): Boolean = !alreadyQueued
}

internal object MainaNativeReadSafetyPolicy {
    fun shouldPersistRead(
        readBytes: Int,
        running: Boolean,
        paused: Boolean,
        readEnabled: Boolean,
    ): Boolean = readBytes > 0 && running && !paused && readEnabled
}

/** Pure native ownership guard shared by recorder creation and route recovery. */
internal object MainaNativeRecorderOwnershipPolicy {
    fun recoveryMayProceed(running: Boolean, paused: Boolean): Boolean = running && !paused

    fun latchGenerationMatches(expected: Long, current: Long): Boolean = expected == current

    fun ownershipMayBeReturned(
        expectedLatchGeneration: Long,
        currentLatchGeneration: Long,
        running: Boolean,
        paused: Boolean,
    ): Boolean = latchGenerationMatches(expectedLatchGeneration, currentLatchGeneration) &&
        recoveryMayProceed(running, paused)
}

internal object MainaNativePauseCheckpointPolicy {
    fun requiresCheckpoint(
        workerPresent: Boolean,
        recorderPresent: Boolean,
        preparedChunkPresent: Boolean,
    ): Boolean = workerPresent || recorderPresent || preparedChunkPresent
}

/** Linearizes the final post-read predicate and PCM byte commit with the latch. */
internal class MainaReadCommitBarrier {
    private val lock = Any()

    fun latch(disableReads: () -> Unit) {
        synchronized(lock) { disableReads() }
    }

    fun commitIf(allowed: () -> Boolean, commit: () -> Unit): Boolean = synchronized(lock) {
        if (!allowed()) return@synchronized false
        commit()
        true
    }
}

internal object MainaCallInterruptionPolicy {
    const val STABLE_NORMAL_MS = 750L
    const val RESUME_RETRY_BUDGET_MS = 30_000L

    fun communicationActive(audioMode: Int, clientSilenced: Boolean): Boolean = clientSilenced || when (audioMode) {
        AudioManager.MODE_RINGTONE,
        AudioManager.MODE_IN_CALL,
        AudioManager.MODE_IN_COMMUNICATION,
        AudioManager.MODE_CALL_SCREENING,
        AudioManager.MODE_CALL_REDIRECT,
        AudioManager.MODE_COMMUNICATION_REDIRECT,
        -> true
        else -> false
    }

    /** A failed refresh preserves the last privacy-safe value; a fresh value replaces it. */
    fun refreshedClientSilenced(cached: Boolean, observed: Boolean?): Boolean = observed ?: cached

    fun shouldWatchCommunication(state: MainaCaptureControlState): Boolean =
        state.phase !in setOf(MainaCaptureControlPhase.IDLE, MainaCaptureControlPhase.TERMINAL)

    fun ownershipPublicationAllowed(
        state: MainaCaptureControlState,
        expectedPhase: MainaCaptureControlPhase,
        owner: MainaCapturePauseOwner,
        expectedGeneration: Long?,
        observedCommunicationActive: Boolean,
    ): Boolean = state.phase == expectedPhase &&
        state.pauseOwner == owner &&
        (expectedGeneration == null || state.generation == expectedGeneration) &&
        !observedCommunicationActive

    fun onCommunicationChanged(
        state: MainaCaptureControlState,
        active: Boolean,
    ): MainaCaptureControlDecision {
        val changed = active != state.communicationActive
        val observed = state.copy(
            communicationActive = active,
            generation = state.generation + if (changed) 1L else 0L,
        )
        if (active && state.phase == MainaCaptureControlPhase.RECORDING) {
            return MainaCaptureControlDecision.Pause(
                observed.copy(
                    phase = MainaCaptureControlPhase.PAUSE_PENDING,
                    pauseOwner = MainaCapturePauseOwner.SYSTEM,
                    generation = observed.generation + if (changed) 0L else 1L,
                ),
            )
        }
        if (active && state.phase == MainaCaptureControlPhase.RESUME_PENDING) {
            return MainaCaptureControlDecision.StateOnly(
                observed.copy(
                    phase = MainaCaptureControlPhase.PAUSED,
                    // A manual resume interrupted by a call becomes a bounded
                    // system recovery. It must not remain stuck pending, while
                    // a deliberate manual pause still never auto-resumes.
                    pauseOwner = MainaCapturePauseOwner.SYSTEM,
                ),
            )
        }
        if (!active && state.phase == MainaCaptureControlPhase.PAUSED && state.pauseOwner == MainaCapturePauseOwner.SYSTEM) {
            return MainaCaptureControlDecision.Resume(
                observed.copy(
                    phase = MainaCaptureControlPhase.RESUME_PENDING,
                    generation = observed.generation + if (changed) 0L else 1L,
                ),
            )
        }
        return MainaCaptureControlDecision.StateOnly(observed)
    }

    /**
     * A communication-clear callback can arrive while the active WAV is still
     * being fsynced. Completion must consume the latest observed communication
     * truth instead of discarding the checkpoint behind an older generation.
     */
    fun onPauseCompleted(state: MainaCaptureControlState): MainaCaptureControlDecision {
        if (state.phase != MainaCaptureControlPhase.PAUSE_PENDING) {
            return MainaCaptureControlDecision.StateOnly(state)
        }
        val paused = state.copy(phase = MainaCaptureControlPhase.PAUSED)
        if (paused.pauseOwner == MainaCapturePauseOwner.SYSTEM && !paused.communicationActive) {
            return MainaCaptureControlDecision.Resume(
                paused.copy(
                    phase = MainaCaptureControlPhase.RESUME_PENDING,
                    generation = paused.generation + 1L,
                ),
            )
        }
        return MainaCaptureControlDecision.StateOnly(paused)
    }

    fun onManualPause(state: MainaCaptureControlState): MainaCaptureControlDecision {
        if (state.phase == MainaCaptureControlPhase.PAUSE_PENDING
            && state.pauseOwner == MainaCapturePauseOwner.SYSTEM
        ) {
            return MainaCaptureControlDecision.Pause(
                state.copy(
                    pauseOwner = MainaCapturePauseOwner.MANUAL,
                    generation = state.generation + 1L,
                ),
            )
        }
        if (state.phase == MainaCaptureControlPhase.PAUSED
            && state.pauseOwner == MainaCapturePauseOwner.SYSTEM
        ) {
            return MainaCaptureControlDecision.StateOnly(
                state.copy(
                    pauseOwner = MainaCapturePauseOwner.MANUAL,
                    generation = state.generation + 1L,
                ),
            )
        }
        if (state.phase !in setOf(MainaCaptureControlPhase.RECORDING, MainaCaptureControlPhase.RESUME_PENDING)) {
            return MainaCaptureControlDecision.StateOnly(state)
        }
        return MainaCaptureControlDecision.Pause(
            state.copy(
                phase = MainaCaptureControlPhase.PAUSE_PENDING,
                pauseOwner = MainaCapturePauseOwner.MANUAL,
                generation = state.generation + 1L,
            ),
        )
    }

    fun onManualResume(state: MainaCaptureControlState): MainaCaptureControlDecision {
        if (state.communicationActive) return MainaCaptureControlDecision.Denied(state)
        if (state.phase != MainaCaptureControlPhase.PAUSED) {
            return MainaCaptureControlDecision.StateOnly(state)
        }
        return MainaCaptureControlDecision.Resume(
            state.copy(
                phase = MainaCaptureControlPhase.RESUME_PENDING,
                pauseOwner = MainaCapturePauseOwner.MANUAL,
                generation = state.generation + 1L,
            ),
        )
    }

    fun resumeSucceeded(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.RECORDING,
        pauseOwner = MainaCapturePauseOwner.NONE,
    )

    fun pauseSucceeded(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.PAUSED,
    )

    fun pauseFailed(state: MainaCaptureControlState): MainaCaptureControlState = terminal(state)

    fun resumeFailed(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.PAUSED,
    )

    fun terminal(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.TERMINAL,
        generation = state.generation + 1L,
    )

    fun shouldRestoreAfterProcessDeath(state: MainaCaptureControlState): Boolean =
        state.phase !in setOf(MainaCaptureControlPhase.IDLE, MainaCaptureControlPhase.TERMINAL)

    /** Process recreation never assumes microphone ownership survived. */
    fun restoreAfterProcessDeath(
        state: MainaCaptureControlState,
        communicationActive: Boolean,
    ): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.PAUSED,
        pauseOwner = if (state.pauseOwner == MainaCapturePauseOwner.MANUAL) {
            MainaCapturePauseOwner.MANUAL
        } else {
            MainaCapturePauseOwner.SYSTEM
        },
        generation = state.generation + 1L,
        communicationActive = communicationActive,
    )

    fun resumeRetryDelayMs(attempt: Int): Long = when (attempt.coerceAtLeast(0)) {
        0 -> STABLE_NORMAL_MS
        1 -> 1_500L
        2 -> 3_000L
        else -> 5_000L
    }
}
