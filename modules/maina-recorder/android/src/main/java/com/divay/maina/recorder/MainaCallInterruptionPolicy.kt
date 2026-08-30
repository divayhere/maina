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
        if (active && state.phase == MainaCaptureControlPhase.RESUME_PENDING
            && state.pauseOwner == MainaCapturePauseOwner.SYSTEM
        ) {
            return MainaCaptureControlDecision.StateOnly(
                observed.copy(phase = MainaCaptureControlPhase.PAUSED),
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

    fun resumeFailed(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.PAUSED,
    )

    fun terminal(state: MainaCaptureControlState): MainaCaptureControlState = state.copy(
        phase = MainaCaptureControlPhase.TERMINAL,
        generation = state.generation + 1L,
    )

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
